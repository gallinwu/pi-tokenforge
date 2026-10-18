/**
 * Unit suite for the history-surface cores and metering.
 * Run: node --experimental-strip-types --test test/history.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPrune,
  buildPrunePlaceholder,
  DEFAULT_PRUNE,
  hasImage,
  messageText,
  PRUNE_MARKER,
  renderSkillCatalog,
  scoreSkill,
  selectPrunable,
  selectSkills,
  stripSkillCatalog,
  type PrunableMessage,
} from "../src/disclose.ts";
import {
  byteSavings,
  cacheHitRate,
  createStats,
  recordUsage,
  resetStats,
  statusLines,
} from "../src/meter.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toolResult(text: string, extras: Record<string, unknown> = {}): PrunableMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text }],
    ...extras,
  };
}

function conversation(toolMessages: number, tailMessages: number, size = 4000): PrunableMessage[] {
  const messages: PrunableMessage[] = [{ role: "user", content: "start" }];
  for (let i = 0; i < toolMessages; i++) {
    messages.push(toolResult("x".repeat(size), { toolCallId: "call-" + i }));
    messages.push({ role: "assistant", content: "ok" });
  }
  for (let i = 0; i < tailMessages; i++) {
    messages.push({ role: "user", content: "recent " + i });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// message inspection
// ---------------------------------------------------------------------------

test("messageText joins text blocks and ignores others", () => {
  assert.equal(messageText({ role: "toolResult", content: [{ type: "text", text: "a" }] }), "a");
  assert.equal(
    messageText({
      role: "toolResult",
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "x" },
        { type: "text", text: "b" },
      ],
    }),
    "a\nb",
  );
  assert.equal(messageText({ role: "toolResult", content: "plain" }), "plain");
  assert.equal(messageText({ role: "toolResult" }), "");
});

test("hasImage detects image blocks", () => {
  assert.equal(
    hasImage({ role: "toolResult", content: [{ type: "image", data: "x" }] }),
    true,
  );
  assert.equal(hasImage(toolResult("text")), false);
});

// ---------------------------------------------------------------------------
// pruning selection
// ---------------------------------------------------------------------------

test("selectPrunable leaves the protected tail alone", () => {
  const messages = conversation(20, DEFAULT_PRUNE.keepRecentMessages);
  const selection = selectPrunable(messages, DEFAULT_PRUNE);
  const floor = messages.length - DEFAULT_PRUNE.keepRecentMessages;
  for (const index of selection.indexes) {
    assert.ok(index < floor, "index " + index + " is inside the protected tail");
  }
});

test("selectPrunable never picks an image-bearing result", () => {
  const messages: PrunableMessage[] = [];
  for (let i = 0; i < 20; i++) {
    messages.push({
      role: "toolResult",
      toolName: "read",
      content: [
        { type: "text", text: "y".repeat(8000) },
        { type: "image", data: "AAAA" },
      ],
    });
  }
  for (let i = 0; i < 20; i++) messages.push({ role: "user", content: "tail " + i });
  assert.deepEqual(selectPrunable(messages, DEFAULT_PRUNE).indexes, []);
});

test("selectPrunable skips results below the byte floor", () => {
  const messages = conversation(20, 20, 100);
  assert.deepEqual(selectPrunable(messages, DEFAULT_PRUNE).indexes, []);
});

test("selectPrunable is idempotent on an already-pruned transcript", () => {
  const messages = conversation(20, 20);
  const first = selectPrunable(messages, DEFAULT_PRUNE);
  assert.ok(first.indexes.length > 0);

  const pruned = applyPrune(messages, first.indexes, () => "/tmp/x.txt");

  // Re-running selects further untouched results (maxPerPass caps one pass), but
  // it must never select a message that was already replaced by a placeholder.
  const second = selectPrunable(pruned, DEFAULT_PRUNE);
  for (const index of second.indexes) {
    assert.ok(!first.indexes.includes(index), "index " + index + " was already pruned");
    assert.ok(!messageText(pruned[index]).startsWith(PRUNE_MARKER));
  }
});

test("selectPrunable stops once every eligible result is pruned", () => {
  const messages = conversation(20, 20);
  let current = messages;
  for (let pass = 0; pass < 50; pass++) {
    const selection = selectPrunable(current, DEFAULT_PRUNE);
    if (selection.indexes.length === 0) break;
    current = applyPrune(current, selection.indexes, () => "/tmp/x.txt");
  }
  assert.deepEqual(selectPrunable(current, DEFAULT_PRUNE).indexes, []);
});

test("selectPrunable honours the batch threshold", () => {
  // One 2000-byte result alone cannot clear a huge batch requirement.
  const messages: PrunableMessage[] = [toolResult("z".repeat(2000))];
  for (let i = 0; i < 20; i++) messages.push({ role: "user", content: "tail " + i });
  const selection = selectPrunable(messages, { ...DEFAULT_PRUNE, minBatchTokens: 100000 });
  assert.deepEqual(selection.indexes, []);
  assert.equal(selection.reclaimedTokens, 0);
});

test("selectPrunable caps how many messages one pass touches", () => {
  const messages = conversation(40, DEFAULT_PRUNE.keepRecentMessages);
  const selection = selectPrunable(messages, { ...DEFAULT_PRUNE, maxPerPass: 3 });
  assert.ok(selection.indexes.length <= 3);
});

test("selectPrunable prefers the largest results", () => {
  const messages: PrunableMessage[] = [];
  messages.push(toolResult("s".repeat(3000), { toolCallId: "small" }));
  messages.push(toolResult("l".repeat(30000), { toolCallId: "large" }));
  for (let i = 0; i < 20; i++) messages.push({ role: "user", content: "tail " + i });

  const selection = selectPrunable(messages, { ...DEFAULT_PRUNE, maxPerPass: 1, minBatchTokens: 1 });
  assert.deepEqual(selection.indexes, [1]);
});

// ---------------------------------------------------------------------------
// pruning application
// ---------------------------------------------------------------------------

test("applyPrune keeps message count and role, replaces only content", () => {
  const messages = conversation(20, 20);
  const selection = selectPrunable(messages, DEFAULT_PRUNE);
  const pruned = applyPrune(messages, selection.indexes, () => "/tmp/spill.txt");

  assert.equal(pruned.length, messages.length, "message count must not change");
  for (let i = 0; i < pruned.length; i++) {
    assert.equal(pruned[i].role, messages[i].role);
    assert.equal(pruned[i].toolCallId, messages[i].toolCallId);
  }
  for (const index of selection.indexes) {
    assert.ok(messageText(pruned[index]).startsWith(PRUNE_MARKER));
  }
});

test("applyPrune passes untouched messages through by reference", () => {
  const messages = conversation(20, 20);
  const selection = selectPrunable(messages, DEFAULT_PRUNE);
  const keepIndex = messages.findIndex((message) => message.role === "user");
  const pruned = applyPrune(messages, selection.indexes, () => null);
  assert.equal(pruned[keepIndex], messages[keepIndex]);
});

test("applyPrune records where the original went", () => {
  const messages = conversation(20, 20);
  const selection = selectPrunable(messages, DEFAULT_PRUNE);
  const pruned = applyPrune(messages, selection.indexes, () => "/tmp/abc.txt");
  const text = messageText(pruned[selection.indexes[0]]);
  assert.ok(text.includes("/tmp/abc.txt"));
});

test("buildPrunePlaceholder admits when nothing was persisted", () => {
  const text = buildPrunePlaceholder("bash", 4096, null);
  assert.ok(text.includes("re-run the command"));
  assert.ok(!text.includes("preserved at"));
});

// ---------------------------------------------------------------------------
// skill disclosure
// ---------------------------------------------------------------------------

const skills = [
  { name: "docker-deploy", description: "Ship containers to production" },
  { name: "sql-migration", description: "Write and review database migrations" },
  { name: "react-forms", description: "Build forms with React hooks" },
  { name: "kubernetes-debug", description: "Debug pods and services" },
  { name: "pdf-export", description: "Render documents to PDF" },
];

test("scoreSkill ranks a name match above a description match", () => {
  const task = "docker-deploy the service";
  assert.ok(scoreSkill(skills[0], task) > scoreSkill(skills[1], task));
});

test("scoreSkill returns zero for unrelated text", () => {
  assert.equal(scoreSkill(skills[4], "unrelated zzz"), 0);
});

test("selectSkills returns everything when under the cap", () => {
  assert.deepEqual(selectSkills(skills, "anything", { maxKeep: 10, minKeep: 2 }), skills);
});

test("selectSkills keeps the relevant skill", () => {
  const chosen = selectSkills(skills, "how do I docker-deploy", { maxKeep: 2, minKeep: 1 });
  assert.equal(chosen.length, 2);
  assert.ok(chosen.some((skill) => skill.name === "docker-deploy"));
});

test("selectSkills preserves original order", () => {
  const chosen = selectSkills(skills, "migrations and forms", { maxKeep: 3, minKeep: 1 });
  const originalOrder = skills.filter((skill) => chosen.includes(skill));
  assert.deepEqual(chosen, originalOrder);
});

test("selectSkills never returns fewer than minKeep", () => {
  const chosen = selectSkills(skills, "zzz", { maxKeep: 3, minKeep: 3 });
  assert.equal(chosen.length, 3);
});

test("selectSkills is deterministic", () => {
  const a = selectSkills(skills, "kubernetes pods", { maxKeep: 2, minKeep: 1 });
  const b = selectSkills(skills, "kubernetes pods", { maxKeep: 2, minKeep: 1 });
  assert.deepEqual(a, b);
});

test("renderSkillCatalog produces a well-formed block", () => {
  const text = renderSkillCatalog([{ name: "a", description: "b", filePath: "/x/SKILL.md" }]);
  assert.ok(text.includes("<available_skills>"));
  assert.ok(text.includes("<name>a</name>"));
  assert.ok(text.includes("<location>/x/SKILL.md</location>"));
});

test("renderSkillCatalog escapes XML", () => {
  const text = renderSkillCatalog([{ name: "a&b", description: "<c>" }]);
  assert.ok(text.includes("a&amp;b"));
  assert.ok(text.includes("&lt;c&gt;"));
});

test("stripSkillCatalog removes an existing block", () => {
  const prompt = "before\n\n<available_skills>\n  <skill>x</skill>\n</available_skills>";
  const stripped = stripSkillCatalog(prompt);
  assert.ok(!stripped.includes("<available_skills>"));
  assert.ok(stripped.startsWith("before"));
});

// ---------------------------------------------------------------------------
// metering
// ---------------------------------------------------------------------------

test("recordUsage folds every counter", () => {
  const stats = createStats();
  recordUsage(stats, {
    input: 100,
    output: 20,
    cacheRead: 900,
    cacheWrite: 5,
    reasoning: 7,
    cost: { total: 0.25 },
  });
  assert.equal(stats.billed.input, 100);
  assert.equal(stats.billed.cacheRead, 900);
  assert.equal(stats.billed.reasoning, 7);
  assert.equal(stats.billed.requests, 1);
  assert.equal(stats.billed.costTotal, 0.25);
});

test("recordUsage ignores junk", () => {
  const stats = createStats();
  assert.equal(recordUsage(stats, null), false);
  assert.equal(recordUsage(stats, undefined), false);
  assert.equal(stats.billed.requests, 0);
});

test("cacheHitRate is null before any usage", () => {
  assert.equal(cacheHitRate(createStats().billed), null);
});

test("cacheHitRate reflects the cache share", () => {
  const stats = createStats();
  recordUsage(stats, { input: 1000, output: 0, cacheRead: 9000, cacheWrite: 0, cost: { total: 0 } });
  assert.equal(cacheHitRate(stats.billed), 90);
});

test("byteSavings reports absolute and relative", () => {
  const stats = createStats();
  stats.bytesBefore = 10000;
  stats.bytesAfter = 2500;
  const savings = byteSavings(stats);
  assert.equal(savings.saved, 7500);
  assert.equal(savings.percent, 75);
});

test("byteSavings is safe with no data", () => {
  const savings = byteSavings(createStats());
  assert.equal(savings.saved, 0);
  assert.equal(savings.percent, 0);
});

test("resetStats clears counters but keeps the object identity", () => {
  const stats = createStats();
  stats.reductions = 5;
  recordUsage(stats, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } });
  resetStats(stats);
  assert.equal(stats.reductions, 0);
  assert.equal(stats.billed.requests, 0);
});

test("statusLines separates avoided from billed", () => {
  const stats = createStats();
  stats.reductions = 3;
  stats.avoidedTokens = 1234;
  recordUsage(stats, { input: 500, output: 50, cacheRead: 4500, cacheWrite: 0, cost: { total: 0.1 } });

  const lines = statusLines(stats, String, {
    compress: true,
    dedupe: true,
    prune: false,
    disclose: true,
  });
  const byLabel = new Map(lines.map((line) => [line.label, line.value]));
  assert.ok(byLabel.get("avoided")!.includes("not billing"));
  assert.ok(byLabel.get("billed")!.includes("input 500"));
  assert.equal(byLabel.get("cache hit"), "90%");
  assert.ok(byLabel.get("modes")!.includes("prune off"));
});
