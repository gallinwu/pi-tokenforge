/**
 * TokenForge — pure decision cores for the two "history" surfaces:
 *
 *   1. stale tool-result pruning (`context` hook)
 *   2. skill catalog disclosure (`before_agent_start` hook)
 *
 * Both are deliberately conservative: they answer "is this safe to shrink"
 * and never touch anything they cannot reason about. No I/O here.
 */

import { estimateTokens, utf8Bytes } from "./reduce.ts";

// ---------------------------------------------------------------------------
// stale tool-result pruning
// ---------------------------------------------------------------------------

/** Minimal shape this module needs from a transcript message. */
export interface PrunableMessage {
  role: string;
  toolCallId?: string;
  toolName?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface PruneOptions {
  /** Only consider messages older than this many messages from the end. */
  keepRecentMessages: number;
  /** Never prune a result smaller than this (bytes). */
  minBytes: number;
  /** Estimated tokens that must be reclaimed before a batch is committed. */
  minBatchTokens: number;
  /** Cap on messages pruned in one pass. */
  maxPerPass: number;
}

export const DEFAULT_PRUNE: PruneOptions = {
  keepRecentMessages: 12,
  minBytes: 2000,
  minBatchTokens: 800,
  maxPerPass: 6,
};

/** Concatenate the text blocks of a tool-result message. */
export function messageText(message: PrunableMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i] as { type?: string; text?: string };
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** True when the message carries an image block — never shrink those. */
export function hasImage(message: PrunableMessage): boolean {
  const content = message.content;
  if (!Array.isArray(content)) return false;
  for (let i = 0; i < content.length; i++) {
    const block = content[i] as { type?: string };
    if (block && block.type === "image") return true;
  }
  return false;
}

/**
 * Choose which tool results to replace with a placeholder.
 *
 * Selection rules, in order:
 *  - only `toolResult` messages;
 *  - never inside the protected tail (`keepRecentMessages`);
 *  - never an image-bearing result;
 *  - never below `minBytes`;
 *  - never one already marked as pruned (idempotent — re-running the hook on
 *    an unchanged transcript must not shrink the same message twice);
 *  - largest first, so a small number of messages reclaims the most.
 *
 * A batch is only returned when the estimated reclaim clears `minBatchTokens`;
 * otherwise the caller leaves the transcript alone. That threshold is what
 * keeps this from rewriting history at every single step, which would invalidate
 * the provider's prefix cache on every request.
 */
export function selectPrunable(
  messages: PrunableMessage[],
  options: PruneOptions = DEFAULT_PRUNE,
): { indexes: number[]; reclaimedTokens: number } {
  const floorIndex = Math.max(0, messages.length - options.keepRecentMessages);
  const candidates: Array<{ index: number; tokens: number }> = [];

  for (let i = 0; i < floorIndex; i++) {
    const message = messages[i];
    if (message.role !== "toolResult") continue;
    if (hasImage(message)) continue;

    const text = messageText(message);
    if (!text) continue;
    if (isPrunedPlaceholder(text)) continue;
    if (utf8Bytes(text) < options.minBytes) continue;

    candidates.push({ index: i, tokens: estimateTokens(text) });
  }

  candidates.sort((a, b) => b.tokens - a.tokens);

  const chosen: number[] = [];
  let reclaimed = 0;
  for (let i = 0; i < candidates.length && chosen.length < options.maxPerPass; i++) {
    chosen.push(candidates[i].index);
    reclaimed += candidates[i].tokens;
  }

  if (reclaimed < options.minBatchTokens) return { indexes: [], reclaimedTokens: 0 };
  chosen.sort((a, b) => a - b);
  return { indexes: chosen, reclaimedTokens: reclaimed };
}

export const PRUNE_MARKER = "[tokenforge pruned]";

export function isPrunedPlaceholder(text: string): boolean {
  return text.startsWith(PRUNE_MARKER);
}

/**
 * Build the placeholder that replaces a pruned tool result.
 *
 * It keeps the tool name, the original size and the recovery path, so the model
 * can tell what it lost and ask for it back. The message itself is preserved —
 * deleting it would break tool-call/tool-result pairing, which every provider
 * validates.
 */
export function buildPrunePlaceholder(toolName: string, bytes: number, locator: string | null): string {
  return (
    PRUNE_MARKER +
    " earlier " +
    (toolName || "tool") +
    " result (" +
    Math.round(bytes / 1024) +
    " KB) removed from the active context to save tokens. " +
    (locator
      ? "Full text preserved at: " + locator + ". Read it if an earlier detail matters."
      : "The result was not persisted; re-run the command if you need it again.")
  );
}

/**
 * Replace the content of selected messages, preserving everything else.
 *
 * Returns a new array; the input is never mutated. Messages that are not
 * selected are passed through by reference, which keeps the host's identity
 * comparison meaningful.
 */
export function applyPrune(
  messages: PrunableMessage[],
  indexes: number[],
  locatorFor: (message: PrunableMessage, index: number) => string | null,
): PrunableMessage[] {
  const selected = new Set(indexes);
  return messages.map((message, index) => {
    if (!selected.has(index)) return message;
    const bytes = utf8Bytes(messageText(message));
    return {
      ...message,
      content: [
        {
          type: "text",
          text: buildPrunePlaceholder(String(message.toolName ?? ""), bytes, locatorFor(message, index)),
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// skill catalog disclosure
// ---------------------------------------------------------------------------

export interface SkillLike {
  name: string;
  description: string;
  [key: string]: unknown;
}

/**
 * Score a skill against the current task text.
 *
 * Deliberately dumb and explainable: token overlap on the name (weighted 3x)
 * and the description, with a small bonus for a name that appears verbatim.
 * No model call — a judge model would cost more than the catalog it filters.
 */
export function scoreSkill(skill: SkillLike, taskText: string): number {
  const haystack = String(taskText || "").toLowerCase();
  if (!haystack) return 0;

  const name = String(skill.name || "").toLowerCase();
  const description = String(skill.description || "").toLowerCase();

  let score = 0;
  if (name && haystack.includes(name)) score += 6;

  const words = new Set<string>();
  for (const word of (name + " " + description).split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (word.length >= 3) words.add(word);
  }
  words.forEach((word) => {
    if (haystack.includes(word)) score += name.includes(word) ? 3 : 1;
  });
  return score;
}

/**
 * Pick the skills worth showing this turn.
 *
 * Always keeps at least `minKeep` (a catalog with zero entries looks broken and
 * stops the model from discovering anything), and caps at `maxKeep`. Order is
 * by score then by original position, so output is stable across calls with the
 * same input — an unstable catalog would churn the prompt prefix every turn.
 */
export function selectSkills<T extends SkillLike>(
  skills: T[],
  taskText: string,
  options: { maxKeep: number; minKeep: number },
): T[] {
  if (skills.length <= options.maxKeep) return skills;

  const scored = skills.map((skill, index) => ({ skill, index, score: scoreSkill(skill, taskText) }));
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));

  const keep = Math.max(options.minKeep, Math.min(options.maxKeep, scored.length));
  const chosen = scored.slice(0, keep);
  chosen.sort((a, b) => a.index - b.index);
  return chosen.map((entry) => entry.skill);
}

/**
 * Render a skill catalog section in the same shape pi uses, so a filtered
 * catalog is indistinguishable from a native one to the model.
 */
export function renderSkillCatalog(skills: SkillLike[]): string {
  if (skills.length === 0) return "";
  const escape = (value: string) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push("    <name>" + escape(skill.name) + "</name>");
    lines.push("    <description>" + escape(skill.description) + "</description>");
    if (typeof (skill as any).filePath === "string") {
      lines.push("    <location>" + escape((skill as any).filePath) + "</location>");
    }
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/**
 * Remove every existing `<available_skills>` block from a prompt so a filtered
 * catalog can be appended without duplicating the native one.
 */
export function stripSkillCatalog(prompt: string): string {
  return prompt.replace(/\n*<available_skills>[\s\S]*?<\/available_skills>\s*$/m, "").replace(/\s+$/, "");
}
