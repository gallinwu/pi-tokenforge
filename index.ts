/**
 * TokenForge — a pi coding-agent extension that cuts context cost without
 * cutting model capability.
 *
 * Four independent techniques, each individually switchable, each reversible:
 *
 *   1. entry reduction   — reshape a tool result before it enters the session
 *   2. cross-turn dedupe — collapse byte-identical repeats inside a TTL window
 *   3. stale pruning     — replace old tool results with a recoverable stub
 *   4. skill disclosure  — show only the skills relevant to the current task
 *
 * Every rewrite is persisted first and carries two recovery channels (a tool and
 * a raw file path). Nothing is destroyed: pruning replaces content, it never
 * removes the message, because dropping a tool result breaks tool-call pairing
 * that every provider validates.
 *
 * Measured, not asserted: `/tokenforge status` reports avoided tokens (a model
 * of a counterfactual) separately from billed tokens (the invoice), plus the
 * provider cache hit rate. Reductions that quietly raise the bill announce
 * themselves there.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";

import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import {
  argsToString,
  buildDedupeStub,
  buildNotice,
  dedupeKey,
  effectiveFloor,
  estimateTokens,
  formatInt,
  reduce,
  utf8Bytes,
  type ReduceOptions,
} from "./src/reduce.ts";
import {
  applyPrune,
  DEFAULT_PRUNE,
  messageText,
  selectPrunable,
  selectSkills,
  type PruneOptions,
  type PrunableMessage,
  type SkillLike,
} from "./src/disclose.ts";
import {
  cacheHitRate,
  createStats,
  recordUsage,
  resetStats,
  statusLines,
  type ForgeStats,
} from "./src/meter.ts";

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

export interface TokenForgeConfig extends ReduceOptions, PruneOptions {
  /** Technique 1: reshape a tool result on entry. */
  compressEnabled: boolean;
  /** Technique 2: collapse identical repeats. */
  dedupeEnabled: boolean;
  /** Technique 3: prune stale results from the active context. */
  pruneEnabled: boolean;
  /** Technique 4: filter the skill catalog per task. */
  discloseEnabled: boolean;

  dedupeTtlMs: number;
  dedupeTtlOverrides: Record<string, number>;
  exemptTools: string[];
  /** Rewrite results of nested tool calls. pi keeps those out of the transcript. */
  nestedEnabled: boolean;

  skillMaxKeep: number;
  skillMinKeep: number;

  /** Verbose recovery trailers before switching to the compact form. */
  noticeFullCount: number;
  /** Context-usage watermark that triggers a prune pass, as a window fraction. */
  pruneWatermarkRatio: number;
}

export const DEFAULT_CONFIG: TokenForgeConfig = {
  compressEnabled: true,
  dedupeEnabled: true,
  pruneEnabled: false,
  discloseEnabled: true,

  // reduction gate
  minSavingBytes: 500,
  keepRatioMax: 0.72,
  maxParseBytes: 512 * 1024,
  maxLines: 240,
  headLines: 140,
  tailLines: 80,
  tabularHeadRows: 60,
  tabularTailRows: 40,
  tabularSamples: 50,
  longLineChars: 420,
  minTabularRows: 8,

  // dedupe
  dedupeTtlMs: 600_000,
  dedupeTtlOverrides: {},
  exemptTools: ["read", "tokenforge_expand"],
  nestedEnabled: false,

  // pruning — off by default: rewriting already-sent history is the one
  // operation that invalidates the provider's prefix cache, so it has to be a
  // deliberate choice rather than a surprise.
  keepRecentMessages: DEFAULT_PRUNE.keepRecentMessages,
  minBytes: DEFAULT_PRUNE.minBytes,
  minBatchTokens: DEFAULT_PRUNE.minBatchTokens,
  maxPerPass: DEFAULT_PRUNE.maxPerPass,
  pruneWatermarkRatio: 0.75,

  // disclosure
  skillMaxKeep: 12,
  skillMinKeep: 5,

  noticeFullCount: 3,
};

/** Size floor for an ordinary result, before the ratio gate is applied. */
const MIN_BYTES_NORMAL = 1400;
/** Error output gets a much higher floor so debugging scenes stay intact. */
const MIN_BYTES_ERROR = 6000;

// ---------------------------------------------------------------------------
// paths — honour PI_CODING_AGENT_DIR exactly like pi itself
// ---------------------------------------------------------------------------

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim()
  ? path.resolve(process.env.PI_CODING_AGENT_DIR.trim())
  : path.join(os.homedir(), ".pi", "agent");

const DATA_DIR = path.join(AGENT_DIR, "tokenforge");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const SPILL_DIR = path.join(DATA_DIR, "spill");

function loadConfig(): TokenForgeConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return { ...DEFAULT_CONFIG, ...raw };
    }
  } catch {
    // Missing or unreadable config is normal on first run.
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config: TokenForgeConfig): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  } catch {
    // Persistence is best-effort: the session keeps the in-memory config.
  }
}

// ---------------------------------------------------------------------------
// runtime state (process-scoped)
// ---------------------------------------------------------------------------

interface SpillRecord {
  file: string;
  bytes: number;
  createdAt: number;
}

const spillIndex = new Map<string, SpillRecord>();
const dedupeCache = new Map<string, { at: number; id: string; bytes: number }>();
const stats: ForgeStats = createStats();
let fullTrailersUsed = 0;
let lastPruneAt = 0;

function newId(): string {
  return Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6);
}

/**
 * Persist the pristine text and return its absolute path.
 *
 * Returns null on any failure. Callers treat null as "abandon the rewrite" —
 * reversibility is a precondition, not a best-effort feature.
 */
function spill(text: string, id: string): string | null {
  try {
    fs.mkdirSync(SPILL_DIR, { recursive: true });
    const file = path.join(SPILL_DIR, id + ".txt");
    fs.writeFileSync(file, text, "utf-8");
    spillIndex.set(id, { file, bytes: utf8Bytes(text), createdAt: Date.now() });
    return file;
  } catch {
    return null;
  }
}

function pathFor(id: string): string {
  return spillIndex.get(id)?.file ?? path.join(SPILL_DIR, id + ".txt");
}

function pruneDedupeCache(now: number, ttlMs: number): void {
  if (dedupeCache.size < 256) return;
  const horizon = now - Math.max(ttlMs, 60_000) * 4;
  for (const [key, entry] of dedupeCache) {
    if (entry.at < horizon) dedupeCache.delete(key);
  }
}

function sessionIdOf(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function tokenForge(pi: ExtensionAPI) {
  const config = loadConfig();

  // -- recovery tool --------------------------------------------------------
  pi.registerTool({
    name: "tokenforge_expand",
    label: "Expand a tokenforge reduction",
    description:
      "Return the full original text behind a [tokenforge #id] notice. Use it whenever a notice marks content you need verbatim.",
    promptSnippet: "Restore a reduced tool result to its full original text",
    parameters: Type.Object({
      id: Type.String({ description: 'The id from a "[tokenforge #<id>]" notice' }),
    }),
    async execute(_toolCallId, params) {
      const id = String((params as { id: string }).id || "").trim();
      const file = pathFor(id);
      let text: string | null = null;
      try {
        text = fs.readFileSync(file, "utf-8");
      } catch {
        text = null;
      }
      if (text === null) {
        const known = Array.from(spillIndex.keys()).slice(-10);
        return {
          content: [
            {
              type: "text" as const,
              text:
                'No stored original for id "' +
                id +
                '". Known ids: ' +
                (known.length > 0 ? known.join(", ") : "(none)") +
                ". The raw file may still exist at " +
                file +
                ".",
            },
          ],
          details: { id, found: false },
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text }],
        details: { id, found: true, bytes: utf8Bytes(text) },
      };
    },
  });

  // -- technique 1 + 2: entry reduction and dedupe --------------------------
  pi.on("tool_result", (event, ctx) => {
    if (!config.compressEnabled && !config.dedupeEnabled) return;

    const resultEvent = event as ToolResultEvent;
    if (config.exemptTools.includes(resultEvent.toolName)) return;
    if (resultEvent.parentToolCallId && !config.nestedEnabled) return;

    const blocks = resultEvent.content ?? [];
    if (blocks.length === 0) return;
    // A compressed image is a destroyed image: leave any image-bearing result alone.
    if (blocks.some((block) => block.type !== "text")) return;

    const text = blocks.map((block) => (block as { text: string }).text).join("\n");
    if (!text) return;

    const bytes = utf8Bytes(text);
    const floor = effectiveFloor(
      resultEvent.isError ? MIN_BYTES_ERROR : MIN_BYTES_NORMAL,
      config.minSavingBytes,
      config.keepRatioMax,
    );
    if (bytes < floor) {
      stats.skipped++;
      return;
    }

    const now = Date.now();
    const sessionId = sessionIdOf(ctx);
    const argsString = argsToString(resultEvent.input);

    // -- dedupe (lookup only; no spill until something is actually adopted) --
    let fingerprint: string | null = null;
    if (config.dedupeEnabled) {
      const ttl = Object.prototype.hasOwnProperty.call(config.dedupeTtlOverrides, resultEvent.toolName)
        ? config.dedupeTtlOverrides[resultEvent.toolName]
        : config.dedupeTtlMs;
      if (ttl > 0) {
        fingerprint = dedupeKey(sessionId, resultEvent.toolName, argsString, text);
        const hit = dedupeCache.get(fingerprint);
        if (hit && now - hit.at <= ttl) {
          const stub = buildDedupeStub((now - hit.at) / 1000, hit.id, hit.bytes);
          stats.dedupes++;
          stats.bytesBefore += bytes;
          stats.bytesAfter += utf8Bytes(stub);
          stats.avoidedTokens += Math.max(0, estimateTokens(text) - estimateTokens(stub));
          return { content: [{ type: "text" as const, text: stub }] };
        }
      }
    }

    if (!config.compressEnabled) return;

    const adopted = reduce(text, config);
    if (adopted === null) {
      stats.rejected++;
      return;
    }

    // One id and one spill per result, shared by the notice and the dedupe
    // entry. Writing the same original twice doubles disk churn for nothing,
    // and a dedupe stub must never name an id with nothing behind it.
    const id = newId();
    const locator = spill(text, id);
    if (locator === null) {
      stats.unpersisted++;
      return;
    }
    if (fingerprint !== null) {
      dedupeCache.set(fingerprint, { at: now, id, bytes });
      pruneDedupeCache(now, config.dedupeTtlMs);
    }

    const verbose = fullTrailersUsed < config.noticeFullCount;
    if (verbose) fullTrailersUsed++;

    const body = buildNotice({
      id,
      body: adopted.text,
      before: adopted.before,
      after: adopted.after,
      lossless: adopted.lossless,
      stats: adopted.stats,
      locator,
      verbose,
      hint: resultEvent.isError ? "The original error output is preserved in full at that path." : "",
    });

    stats.reductions++;
    stats.bytesBefore += adopted.before;
    stats.bytesAfter += utf8Bytes(body);
    stats.avoidedTokens += Math.max(0, estimateTokens(text) - estimateTokens(body));

    return { content: [{ type: "text" as const, text: body }] };
  });

  // -- technique 3: stale pruning ------------------------------------------
  pi.on("context", (event, ctx) => {
    if (!config.pruneEnabled) return;

    const now = Date.now();
    // A prune rewrites history the provider has already cached, so it is rate
    // limited and watermark-gated. Doing it every step would trade cheap cache
    // reads for full-price inputs on every request.
    if (now - lastPruneAt < 30_000) return;

    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null) return;
    const watermark = Math.floor(usage.contextWindow * config.pruneWatermarkRatio);
    if (usage.tokens < watermark) return;

    const messages = (event as { messages: PrunableMessage[] }).messages;
    const selection = selectPrunable(messages, config);
    if (selection.indexes.length === 0) return;

    const pruned = applyPrune(messages, selection.indexes, (message) => {
      const text = messageText(message);
      if (!text) return null;
      const id = newId();
      return spill(text, id);
    });

    lastPruneAt = now;
    stats.avoidedTokens += selection.reclaimedTokens;
    return { messages: pruned };
  });

  // -- technique 4: skill catalog disclosure -------------------------------
  pi.on("before_agent_start", (event) => {
    if (!config.discloseEnabled) return;

    const promptEvent = event as {
      messageType: string;
      prompt?: string;
      systemPromptOptions?: { skills?: SkillLike[] };
    };
    if (promptEvent.messageType !== "user") return;

    const skills = promptEvent.systemPromptOptions?.skills;
    if (!Array.isArray(skills) || skills.length <= config.skillMaxKeep) return;

    const taskText = String(promptEvent.prompt ?? "");
    if (!taskText) return;

    // Mutate the option list, not the rendered prompt: pi re-renders the
    // catalog from this array, so the model still sees a well-formed native
    // section — and a filtered catalog stays inside the cached prefix shape.
    promptEvent.systemPromptOptions!.skills = selectSkills(skills, taskText, {
      maxKeep: config.skillMaxKeep,
      minKeep: config.skillMinKeep,
    });
  });

  // -- metering ------------------------------------------------------------
  pi.on("message_end", (event) => {
    const message = (event as { message?: { role?: string; usage?: unknown } }).message;
    if (!message || message.role !== "assistant") return;
    recordUsage(stats, message.usage);
  });

  // -- /tokenforge ----------------------------------------------------------
  pi.registerCommand("tokenforge", {
    description:
      "TokenForge status and switches: status | on | off | compress | dedupe | prune | disclose | config | spill | reset",
    handler: async (args, ctx) => {
      const argv = (args || "").trim().split(/\s+/).filter(Boolean);
      const sub = (argv[0] || "status").toLowerCase();
      const notify = (message: string, tone: "info" | "warning" | "error" = "info") =>
        ctx.ui.notify(message, tone);

      const toggle = (key: keyof TokenForgeConfig, label: string, value: boolean) => {
        (config as unknown as Record<string, unknown>)[key] = value;
        saveConfig(config);
        notify("tokenforge: " + label + " " + (value ? "ON" : "OFF"), "info");
      };

      switch (sub) {
        case "on":
          config.compressEnabled = true;
          config.dedupeEnabled = true;
          config.discloseEnabled = true;
          saveConfig(config);
          notify("tokenforge: compress + dedupe + disclose ON (prune stays as configured)", "info");
          return;
        case "off":
          config.compressEnabled = false;
          config.dedupeEnabled = false;
          config.pruneEnabled = false;
          config.discloseEnabled = false;
          saveConfig(config);
          notify("tokenforge: all techniques OFF", "info");
          return;
        case "compress":
          toggle("compressEnabled", "compress", !config.compressEnabled);
          return;
        case "dedupe":
          toggle("dedupeEnabled", "dedupe", !config.dedupeEnabled);
          return;
        case "prune":
          toggle("pruneEnabled", "prune", !config.pruneEnabled);
          return;
        case "disclose":
          toggle("discloseEnabled", "disclose", !config.discloseEnabled);
          return;
        case "config":
          notify("config file: " + CONFIG_FILE + "\n\n" + JSON.stringify(config, null, 2), "info");
          return;
        case "spill": {
          const entries = Array.from(spillIndex.entries()).slice(-10);
          notify(
            "spill dir: " +
              SPILL_DIR +
              "\nwritten this process: " +
              spillIndex.size +
              "\n\n" +
              (entries.length > 0
                ? entries.map(([id, record]) => "#" + id + " -> " + record.file).join("\n")
                : "(none)"),
            "info",
          );
          return;
        }
        case "reset":
          resetStats(stats);
          fullTrailersUsed = 0;
          notify("tokenforge: counters reset", "info");
          return;
        case "status":
        default: {
          const lines = statusLines(stats, formatInt, {
            compress: config.compressEnabled,
            dedupe: config.dedupeEnabled,
            prune: config.pruneEnabled,
            disclose: config.discloseEnabled,
          });
          const width = Math.max(...lines.map((line) => line.label.length));
          const hit = cacheHitRate(stats.billed);
          const warning =
            config.pruneEnabled && hit !== null && hit < 85
              ? "\n\nnote: cache hit rate is below 85% while pruning is on — pruning rewrites history the provider already cached. Consider /tokenforge prune to turn it off."
              : "";
          notify(
            lines.map((line) => line.label.padEnd(width) + "  " + line.value).join("\n") +
              warning +
              "\n\nconfig: " +
              CONFIG_FILE,
            "info",
          );
          return;
        }
      }
    },
  });
}
