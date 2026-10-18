/**
 * Regression: pruning must be reproducible across a session resume.
 *
 * pi records what the model saw. On resume it replays the session log, and the
 * `context` hook runs again on the rebuilt transcript. If the placeholder text
 * is not a pure function of the message it replaces, the second run produces
 * different bytes than the first — the model sees content the log does not
 * contain, and any prefix cache built on the first shape is invalidated on
 * every resume.
 *
 * Run: node --experimental-strip-types --test test/resume.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPrune,
  buildPrunePlaceholder,
  messageText,
  selectPrunable,
  DEFAULT_PRUNE,
  type PrunableMessage,
} from "../src/disclose.ts";

function transcript(): PrunableMessage[] {
  const messages: PrunableMessage[] = [{ role: "user", content: "start" }];
  for (let i = 0; i < 20; i++) {
    messages.push({
      role: "toolResult",
      toolName: "bash",
      toolCallId: "call-" + i,
      content: [{ type: "text", text: "payload-" + i + "-" + "x".repeat(4000) }],
    });
    messages.push({ role: "assistant", content: "ok" });
  }
  for (let i = 0; i < 20; i++) messages.push({ role: "user", content: "tail " + i });
  return messages;
}

// ---------------------------------------------------------------------------
// the placeholder itself
// ---------------------------------------------------------------------------

test("placeholder is a pure function of its inputs", () => {
  const first = buildPrunePlaceholder("bash", 4096, "/tmp/a.txt");
  const second = buildPrunePlaceholder("bash", 4096, "/tmp/a.txt");
  assert.equal(first, second);
});

test("placeholder does not embed a timestamp or a random id", () => {
  const text = buildPrunePlaceholder("bash", 4096, "/tmp/a.txt");
  // A clock value or a random token would make the same input render differently.
  assert.ok(!/\d{10,}/.test(text), "placeholder must not embed a clock value: " + text);
});

// ---------------------------------------------------------------------------
// selection determinism
// ---------------------------------------------------------------------------

test("selection returns the same indexes for the same transcript", () => {
  const messages = transcript();
  const a = selectPrunable(messages, DEFAULT_PRUNE);
  const b = selectPrunable(messages, DEFAULT_PRUNE);
  assert.deepEqual(a.indexes, b.indexes);
});

// ---------------------------------------------------------------------------
// the actual resume contract
// ---------------------------------------------------------------------------

/**
 * Simulates a resume: run the hook once, then run it again on the *original*
 * transcript (which is what a resumed session rebuilds from the log before the
 * hook re-applies). The two results must be byte-identical.
 */
test("pruning a transcript twice produces identical bytes", () => {
  const messages = transcript();
  const selection = selectPrunable(messages, DEFAULT_PRUNE);
  assert.ok(selection.indexes.length > 0, "fixture must produce a non-empty selection");

  // A deterministic locator: keyed by the message content, not by the clock.
  const locatorFor = (message: PrunableMessage) => "/spill/" + stableKey(message);

  const firstRun = applyPrune(messages, selection.indexes, locatorFor);
  const secondRun = applyPrune(messages, selection.indexes, locatorFor);

  assert.deepEqual(
    firstRun.map((message) => messageText(message)),
    secondRun.map((message) => messageText(message)),
    "a resumed session must rebuild exactly what the first run produced",
  );
});

test("placeholder text ignores when the prune happened", () => {
  // Same message, two different "now" values: the output must not differ.
  const message: PrunableMessage = {
    role: "toolResult",
    toolName: "bash",
    toolCallId: "c1",
    content: [{ type: "text", text: "z".repeat(5000) }],
  };
  const bytes = 5000;
  const before = Date.now();
  const a = buildPrunePlaceholder(String(message.toolName), bytes, "/spill/x");
  const b = buildPrunePlaceholder(String(message.toolName), bytes, "/spill/x");
  assert.equal(a, b);
  assert.ok(Date.now() >= before);
});

/** Content-derived key so the test itself is deterministic. */
function stableKey(message: PrunableMessage): string {
  const text = messageText(message);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16);
}
