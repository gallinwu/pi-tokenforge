/**
 * Host harness: boots index.ts the way pi's extension loader does (jiti plus
 * the virtual-module aliases) against a fake ExtensionAPI, then drives every
 * hook and the /tokenforge command. No pi process, no model call.
 *
 * Run: node harness/load.mjs
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

const jiti = createJiti(entry, {
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

// ---------------------------------------------------------------------------
// fake host
// ---------------------------------------------------------------------------

const handlers = new Map();
const tools = new Map();
const commands = new Map();
const notifications = [];

const pi = {
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(handler);
    return () => {};
  },
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
  registerCommand(name, options) {
    commands.set(name, options);
  },
  registerFlag() {},
  registerShortcut() {},
  registerProvider() {},
  registerVirtualModel() {},
  sendMessage() {},
  appendEntry() {},
  events: { emit() {}, on() { return () => {}; } },
};

function makeContext(overrides = {}) {
  return {
    ui: {
      notify(message, tone) {
        notifications.push({ tone: tone || "info", message });
      },
    },
    mode: "tui",
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "harness-session" },
    isIdle: () => true,
    isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: 0, contextWindow: 200000, percent: 0 }),
    compact() {},
    getSystemPrompt: () => "",
    ...overrides,
  };
}

const ctx = makeContext();

async function emit(event, payload, context = ctx) {
  const list = handlers.get(event) || [];
  let result;
  for (const handler of list) {
    const returned = await handler(payload, context);
    if (returned !== undefined) result = returned;
  }
  return result;
}

// ---------------------------------------------------------------------------
// assertions
// ---------------------------------------------------------------------------

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log("  ok    " + name + (detail ? "  — " + detail : ""));
  else {
    failures++;
    console.log("  FAIL  " + name + (detail ? "  — " + detail : ""));
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const module = await jiti.import(entry);
const factory = module.default ?? module;
if (typeof factory !== "function") {
  console.error("entry did not export a factory function");
  process.exit(1);
}
await factory(pi);

console.log("events   :", [...handlers.keys()].join(", "));
console.log("tools    :", [...tools.keys()].join(", "));
console.log("commands :", [...commands.keys()].join(", "));
console.log("");

check("tool_result hook registered", handlers.has("tool_result"));
check("context hook registered", handlers.has("context"));
check("before_agent_start hook registered", handlers.has("before_agent_start"));
check("message_end hook registered", handlers.has("message_end"));
check("recovery tool registered", tools.has("tokenforge_expand"));
check("/tokenforge registered", commands.has("tokenforge"));

// -- 1. small result passes through -----------------------------------------
{
  const result = await emit("tool_result", {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "t1",
    input: { command: "echo hi" },
    content: [{ type: "text", text: "hi\n" }],
    isError: false,
  });
  check("small output untouched", result === undefined);
}

// -- 2. a big JSON table is re-encoded losslessly ---------------------------
const rows = [];
for (let i = 0; i < 300; i++) rows.push({ model: "model-" + i, input: i, output: i * 2 });
const bigJson = JSON.stringify({ data: { items: rows } });

{
  const result = await emit("tool_result", {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "t2",
    input: { command: "cat prices.json" },
    content: [{ type: "text", text: bigJson }],
    isError: false,
  });
  const out = result?.content?.[0]?.text ?? "";
  check("large JSON reduced", out.length > 0 && out.length < bigJson.length);
  check("lossless route announced", out.includes("zero information loss"));
  check("table header present", out.includes("items[300]"));
  check("notice carries an id", /\[tokenforge #[0-9a-z]+/.test(out));

  const id = /\[tokenforge #([0-9a-z]+)/.exec(out)?.[1];
  check("id parsed", Boolean(id), id);

  const expanded = await tools
    .get("tokenforge_expand")
    .execute("c1", { id }, undefined, undefined, ctx);
  check("expand returns the pristine original", expanded.content[0].text === bigJson);
}

// -- 3. byte-identical repeat collapses to a stub ---------------------------
{
  const result = await emit("tool_result", {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "t3",
    input: { command: "cat prices.json" },
    content: [{ type: "text", text: bigJson }],
    isError: false,
  });
  const out = result?.content?.[0]?.text ?? "";
  check("dedupe stub emitted", out.includes("[tokenforge dedupe]"));
}

// -- 4. error logs keep their failure lines --------------------------------
{
  const lines = [];
  for (let i = 0; i < 600; i++) {
    lines.push(i === 300 ? "FAIL src/auth.test.ts > login redirects" : "PASS case " + i);
  }
  const result = await emit("tool_result", {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "t4",
    input: { command: "npm test" },
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
  });
  const out = result?.content?.[0]?.text ?? "";

  // A run of PASS lines is a test log, so the dedicated channel drops them all
  // and keeps only the evidence. A generic window would also pass this, so the
  // check asserts the failure detail rather than the strategy name.
  check("verbose log reduced", out.length > 0 && out.length < lines.join("\n").length, out.length + " bytes");
  check("failure line survives", out.includes("FAIL src/auth.test.ts"));
  check("pass lines dropped", !out.includes("PASS case 42"));
}

// -- 5. image-bearing results are never touched ----------------------------
{
  const result = await emit("tool_result", {
    type: "tool_result",
    toolName: "read",
    toolCallId: "t5",
    input: { path: "shot.png" },
    content: [
      { type: "text", text: "x".repeat(9000) },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
    isError: false,
  });
  check("image result untouched", result === undefined);
}

// -- 6. exempt tool is never touched ---------------------------------------
{
  const result = await emit("tool_result", {
    type: "tool_result",
    toolName: "read",
    toolCallId: "t6",
    input: { path: "big.txt" },
    content: [{ type: "text", text: "y".repeat(20000) }],
    isError: false,
  });
  check("exempt tool untouched", result === undefined);
}

// -- 7. skill catalog filtering --------------------------------------------
{
  const skills = [
    { name: "docker-deploy", description: "Ship containers", filePath: "/s/docker/SKILL.md" },
    { name: "sql-migration", description: "Database migrations", filePath: "/s/sql/SKILL.md" },
    { name: "react-forms", description: "React form hooks", filePath: "/s/react/SKILL.md" },
    { name: "k8s-debug", description: "Debug pods", filePath: "/s/k8s/SKILL.md" },
    { name: "pdf-export", description: "Render PDFs", filePath: "/s/pdf/SKILL.md" },
    { name: "csv-tools", description: "Parse CSV", filePath: "/s/csv/SKILL.md" },
    { name: "email-send", description: "Send mail", filePath: "/s/mail/SKILL.md" },
  ];
  // 7 skills vs maxKeep 12: unchanged. Raise the count past the cap to filter.
  const many = [];
  for (let i = 0; i < 30; i++) {
    many.push({ name: "skill-" + i, description: "generic helper " + i, filePath: "/s/" + i });
  }
  many.push({ name: "docker-deploy", description: "Ship containers", filePath: "/s/docker/SKILL.md" });

  const event = {
    type: "before_agent_start",
    messageType: "user",
    prompt: "please docker-deploy the service",
    systemPromptOptions: { skills: many },
  };
  await emit("before_agent_start", event);
  const kept = event.systemPromptOptions.skills;
  check("catalog filtered", kept.length < many.length, kept.length + " of " + many.length);
  check("relevant skill retained", kept.some((skill) => skill.name === "docker-deploy"));

  const smallEvent = {
    type: "before_agent_start",
    messageType: "user",
    prompt: "hi",
    systemPromptOptions: { skills },
  };
  await emit("before_agent_start", smallEvent);
  check("small catalog untouched", smallEvent.systemPromptOptions.skills.length === skills.length);
}

// -- 8. metering separates avoided from billed -----------------------------
{
  await emit("message_end", {
    type: "message_end",
    message: {
      role: "assistant",
      usage: {
        input: 1000,
        output: 200,
        cacheRead: 9000,
        cacheWrite: 0,
        reasoning: 50,
        totalTokens: 10250,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0, total: 0.033 },
      },
    },
  });
}

// -- 9. /tokenforge status -------------------------------------------------
{
  notifications.length = 0;
  await commands.get("tokenforge").handler("status", ctx);
  const text = notifications.map((entry) => entry.message).join("\n");
  check("status reports reductions", /reductions/.test(text));
  check("status separates avoided", text.includes("not billing"));
  check("status reports cache hit", text.includes("cache hit"));
  check("status shows modes", text.includes("compress on"));
}

// -- 10. switches ----------------------------------------------------------
{
  notifications.length = 0;
  await commands.get("tokenforge").handler("off", ctx);
  const result = await emit("tool_result", {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "t7",
    input: { command: "cat prices.json" },
    content: [{ type: "text", text: bigJson }],
    isError: false,
  });
  check("off disables every technique", result === undefined);
  await commands.get("tokenforge").handler("on", ctx);
}

// -- 11. pruning needs the watermark and is off by default -----------------
{
  const messages = [];
  for (let i = 0; i < 20; i++) {
    messages.push({
      role: "toolResult",
      toolName: "bash",
      toolCallId: "c" + i,
      content: [{ type: "text", text: "z".repeat(4000) }],
    });
  }
  for (let i = 0; i < 20; i++) messages.push({ role: "user", content: "tail " + i });

  const disabled = await emit("context", { type: "context", messages });
  check("prune off by default", disabled === undefined);

  // Turn it on, then push context usage past the watermark.
  const before = notifications.length;
  await commands.get("tokenforge").handler("prune", ctx);
  check("prune toggled on", notifications.slice(before).some((n) => n.message.includes("prune ON")));

  const lowUsage = await emit(
    "context",
    { type: "context", messages },
    makeContext({ getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }) }),
  );
  check("below watermark does nothing", lowUsage === undefined);

  const highUsage = await emit(
    "context",
    { type: "context", messages },
    makeContext({
      getContextUsage: () => ({ tokens: 190000, contextWindow: 200000, percent: 95 }),
    }),
  );
  check("above watermark prunes", Boolean(highUsage?.messages));
  check(
    "message count preserved",
    highUsage?.messages?.length === messages.length,
    String(highUsage?.messages?.length) + " vs " + messages.length,
  );
  check(
    "placeholder written",
    String(highUsage?.messages?.[0]?.content?.[0]?.text ?? "").startsWith("[tokenforge pruned]"),
  );

  await commands.get("tokenforge").handler("prune", ctx);
}

// -- 12. audit is read-only and reports real sizes -------------------------
{
  const entries = [
    { type: "message", message: { role: "user", content: "hello" } },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "a",
        content: [{ type: "text", text: "x".repeat(30000) }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: "b",
        content: [{ type: "text", text: "y".repeat(1000) }],
      },
    },
  ];

  const auditCtx = makeContext({
    sessionManager: { getSessionId: () => "audit-session", getEntries: () => entries },
    getContextUsage: () => ({ tokens: 50000, contextWindow: 200000, percent: 25 }),
  });

  notifications.length = 0;
  await commands.get("tokenforge").handler("audit", auditCtx);
  const text = notifications.map((entry) => entry.message).join("\n");

  check("audit reports context usage", text.includes("50,000"));
  check("audit counts tool results", text.includes("2"));
  check("audit ranks the largest first", text.indexOf("bash") < text.indexOf("read"));
  check("audit names the dominant result", text.includes("narrowing that command"));

  // Read-only invariant: the entries must come back untouched.
  check("audit does not mutate entries", entries[1].message.content[0].text.length === 30000);
}

// -- 13. audit survives a host without entry listing -----------------------
{
  const bare = makeContext({ sessionManager: { getSessionId: () => "s" } });
  notifications.length = 0;
  await commands.get("tokenforge").handler("audit", bare);
  const text = notifications.map((entry) => entry.message).join("\n");
  check("audit degrades gracefully", text.includes("tool results"));
}

// -- 14. config persisted --------------------------------------------------
{
  const configFile = path.join(
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
    "tokenforge",
    "config.json",
  );
  check("config file written", fs.existsSync(configFile), configFile);
}

console.log("");
console.log(failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
