/**
 * Repro: does the `context` hook produce the same placeholder bytes on two
 * independent runs over the same transcript?
 *
 * A resumed session rebuilds the transcript from the log and runs the hook
 * again. If the placeholder is not a pure function of the message, the second
 * run hands the model different bytes than the first — and any prefix cache
 * built on the first shape is dead on arrival.
 *
 * Run: node harness/resume-repro.mjs
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";

const CANDIDATE_ROOTS = [
  path.join(os.homedir(), ".pi", "agent", "install", "releases"),
  "E:/pi/Pi Agent/resources/server/node_modules",
];

function resolvePiRoot() {
  if (process.env.PI_MODULES_ROOT) return process.env.PI_MODULES_ROOT;
  for (const root of CANDIDATE_ROOTS) {
    if (root.endsWith("releases")) {
      if (!fs.existsSync(root)) continue;
      for (const version of fs.readdirSync(root)) {
        const modules = path.join(root, version, "node_modules");
        if (fs.existsSync(path.join(modules, "@earendil-works/pi-coding-agent"))) return modules;
      }
      continue;
    }
    if (fs.existsSync(path.join(root, "@earendil-works/pi-coding-agent"))) return root;
  }
  throw new Error("could not locate a pi installation; set PI_MODULES_ROOT");
}

const PI_ROOT = resolvePiRoot();
const require = createRequire(path.join(PI_ROOT, "index.js"));
const { createJiti } = require(path.join(PI_ROOT, "jiti/lib/jiti.cjs"));

const repoRoot = path.resolve(import.meta.dirname, "..");
const entry = path.join(repoRoot, "index.ts");

function makeJiti() {
  return createJiti(entry, {
    interopDefault: true,
    moduleCache: false,
    alias: {
      "@earendil-works/pi-coding-agent": path.join(
        PI_ROOT,
        "@earendil-works/pi-coding-agent/dist/index.js",
      ),
      "@earendil-works/pi-agent-core": path.join(
        PI_ROOT,
        "@earendil-works/pi-agent-core/dist/index.js",
      ),
      typebox: path.join(PI_ROOT, "typebox/build/index.mjs"),
    },
  });
}

function buildTranscript() {
  const messages = [{ role: "user", content: "start" }];
  for (let i = 0; i < 20; i++) {
    messages.push({
      role: "toolResult",
      toolName: "bash",
      toolCallId: "c" + i,
      content: [{ type: "text", text: "payload-" + i + "-" + "x".repeat(4000) }],
    });
    messages.push({ role: "assistant", content: "ok" });
  }
  for (let i = 0; i < 20; i++) messages.push({ role: "user", content: "tail " + i });
  return messages;
}

/**
 * Boot a fresh module instance and prune once.
 *
 * Both runs share one agent dir on purpose: a resume reuses the same
 * `~/.pi/agent`, so the spill path is part of the reproducible output. Giving
 * each run its own dir would make the paths differ and report a mismatch that
 * no real resume would ever see.
 *
 * The config file *is* process-wide state, so it is removed between runs: two
 * boots sharing one file would have the second run toggle the first run's
 * setting, and this harness exists to measure independence, not to introduce
 * coupling.
 */
const SHARED_AGENT_DIR = path.join(os.tmpdir(), "tokenforge-resume-shared");

async function pruneOnce(label) {
  fs.rmSync(SHARED_AGENT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SHARED_AGENT_DIR, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = SHARED_AGENT_DIR;

  const jiti = makeJiti();
  const handlers = new Map();
  let command;

  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    registerTool() {},
    registerCommand(name, options) {
      if (name === "tokenforge") command = options;
    },
    registerFlag() {},
    registerShortcut() {},
    registerProvider() {},
    registerVirtualModel() {},
    sendMessage() {},
    appendEntry() {},
    events: { emit() {}, on() { return () => {}; } },
  };

  const ctx = {
    ui: { notify() {} },
    mode: "tui",
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "resume-repro" },
    isIdle: () => true,
    isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: 190000, contextWindow: 200000, percent: 95 }),
    compact() {},
    getSystemPrompt: () => "",
  };

  const module = await jiti.import(entry);
  (module.default ?? module)(pi);

  if (!command) throw new Error(label + ": /tokenforge was not registered");

  // Enable pruning through the public command, exactly as a user would.
  await command.handler("prune", ctx);

  // Confirm the toggle actually flipped, rather than trusting it: a silent
  // no-op here would make this whole comparison compare nothing.
  const status = await capture(command, ctx);
  if (!/prune on/.test(status)) {
    throw new Error(label + ": prune did not turn on\n" + status);
  }

  const transcript = buildTranscript();
  for (const handler of handlers.get("context") ?? []) {
    const result = await handler({ type: "context", messages: structuredClone(transcript) }, ctx);
    if (result?.messages) {
      return result.messages.map((message) => {
        const content = message.content;
        if (!Array.isArray(content)) return "";
        return content.map((block) => (block.type === "text" ? block.text : "")).join("");
      });
    }
  }
  throw new Error(label + ": the context hook produced no messages");
}

/** Run /tokenforge status and return what it printed. */
async function capture(command, ctx) {
  const lines = [];
  const original = ctx.ui.notify;
  ctx.ui.notify = (message) => lines.push(String(message));
  try {
    await command.handler("status", ctx);
  } finally {
    ctx.ui.notify = original;
  }
  return lines.join("\n");
}

const first = await pruneOnce("run 1");
const second = await pruneOnce("run 2");

if (first === null || second === null) {
  console.log("SUSPECT: the context hook returned nothing; nothing to compare");
  process.exit(2);
}

let mismatches = 0;
for (let i = 0; i < first.length; i++) {
  if (first[i] !== second[i]) {
    mismatches++;
    if (mismatches <= 2) {
      console.log("--- message " + i + " differs");
      console.log("  run 1: " + JSON.stringify(first[i].slice(0, 180)));
      console.log("  run 2: " + JSON.stringify(second[i].slice(0, 180)));
    }
  }
}

console.log("");
console.log("compared " + first.length + " messages, mismatches: " + mismatches);
if (mismatches > 0) {
  console.log("FAIL: pruning is not reproducible across a resume");
  process.exit(1);
}
console.log("PASS: pruning is byte-identical across independent runs");
