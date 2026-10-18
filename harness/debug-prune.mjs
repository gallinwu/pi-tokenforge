/** Debug: trace why the context hook returns nothing. */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";

const PI_ROOT = path.join(os.homedir(), ".pi", "agent", "install", "releases", "1.3.0", "node_modules");
const require = createRequire(path.join(PI_ROOT, "index.js"));
const { createJiti } = require(path.join(PI_ROOT, "jiti/lib/jiti.cjs"));

const entry = path.resolve(import.meta.dirname, "..", "index.ts");
const jiti = createJiti(entry, {
  interopDefault: true,
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": path.join(PI_ROOT, "@earendil-works/pi-coding-agent/dist/index.js"),
    "@earendil-works/pi-agent-core": path.join(PI_ROOT, "@earendil-works/pi-agent-core/dist/index.js"),
    typebox: path.join(PI_ROOT, "typebox/build/index.mjs"),
  },
});

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
  ui: { notify(m) { console.log("NOTIFY:", String(m).split("\n")[0]); } },
  mode: "tui",
  hasUI: true,
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => "dbg" },
  isIdle: () => true,
  isProjectTrusted: () => true,
  getContextUsage: () => ({ tokens: 190000, contextWindow: 200000, percent: 95 }),
  compact() {},
  getSystemPrompt: () => "",
};

const module = await jiti.import(entry);
(module.default ?? module)(pi);

console.log("commands:", command ? "yes" : "no");
console.log("events:", [...handlers.keys()].join(","));

await command.handler("status", ctx);
const toggled = await command.handler("prune", ctx);
console.log("toggled");

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
console.log("messages:", messages.length, "toolResults:", messages.filter((m) => m.role === "toolResult").length);

const list = handlers.get("context") ?? [];
console.log("context handlers:", list.length);
for (const handler of list) {
  const result = await handler({ type: "context", messages: structuredClone(messages) }, ctx);
  console.log("handler returned:", result ? "messages(" + result.messages.length + ")" : String(result));
}
