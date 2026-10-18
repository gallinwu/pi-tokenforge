/**
 * The fidelity policy: proofs that a reduction cannot eat the evidence.
 *
 * These tests exist because "the heuristic should keep the error" is a hope,
 * while "the candidate is rejected if it dropped one" is a guarantee. Every
 * case below is a way a token saver makes a model dumber, stated as an
 * assertion.
 *
 * Run: node --experimental-strip-types --test test/safety.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  detectTestLog,
  extractEvidence,
  isEvidenceLine,
  isPassOnlyLine,
  reduceTestLog,
  verifyEvidence,
  verifyEvidenceBounded,
} from "../src/safety.ts";
import { reduce, type ReduceOptions } from "../src/reduce.ts";

const options: ReduceOptions = {
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
};

// ---------------------------------------------------------------------------
// evidence classification
// ---------------------------------------------------------------------------

test("failures in every common dialect count as evidence", () => {
  const lines = [
    "FAIL src/auth.test.ts > redirects",
    "FAILED tests/test_api.py::test_login",
    "✗ renders the header",
    "not ok 7 - handles timeout",
    "--- FAIL: TestLogin (0.02s)",
    "3 failing",
    "Tests: 2 failed, 40 passed",
  ];
  for (const line of lines) {
    assert.ok(isEvidenceLine(line), "should be evidence: " + line);
  }
});

test("stack frames and assertion diffs count as evidence", () => {
  const lines = [
    "    at login (src/auth.ts:42:11)",
    '  File "/app/api.py", line 88, in handler',
    "Expected: 302",
    "  expected: 'a'",
    "88:     assert response.status == 302",
  ];
  for (const line of lines) {
    assert.ok(isEvidenceLine(line), "should be evidence: " + line);
  }
});

test("plain passing lines are not evidence", () => {
  for (const line of ["PASS src/a.test.ts", "✓ works", "ok 1 - adds numbers", "[x] renders"]) {
    assert.ok(!isEvidenceLine(line), "should not be evidence: " + line);
  }
});

test("a pass line that also carries an error is treated as evidence", () => {
  // Conservative direction: ambiguity resolves in favour of keeping the line.
  assert.equal(isPassOnlyLine("PASS src/a.test.ts"), true);
  assert.equal(isPassOnlyLine("PASS but with error: ECONNREFUSED"), false);
});

test("blank and trivial lines are never evidence", () => {
  assert.equal(isEvidenceLine(""), false);
  assert.equal(isEvidenceLine("   "), false);
});

test("extractEvidence keeps order and duplicates", () => {
  const text = ["error A", "noise", "error A", "FAIL x"].join("\n");
  const found = extractEvidence(text);
  assert.deepEqual(found, ["error A", "error A", "FAIL x"]);
});

// ---------------------------------------------------------------------------
// the invariant
// ---------------------------------------------------------------------------

test("a candidate that dropped an error is rejected", () => {
  const original = ["ok 1", "ok 2", "error: connection refused", "ok 3"].join("\n");
  const candidate = ["ok 1", "ok 2", "ok 3"].join("\n");
  const verdict = verifyEvidence(original, candidate);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ["error: connection refused"]);
});

test("a candidate that kept everything passes", () => {
  const original = ["ok 1", "error: boom", "ok 2"].join("\n");
  const candidate = ["error: boom", "[... +2 lines omitted ...]"].join("\n");
  assert.equal(verifyEvidence(original, candidate).ok, true);
});

test("reflowed whitespace still counts as kept", () => {
  const original = "FAIL   src/a.test.ts   >   redirects";
  const candidate = "L42: FAIL src/a.test.ts > redirects";
  assert.equal(verifyEvidence(original, candidate).ok, true);
});

test("text with no evidence passes trivially", () => {
  assert.equal(verifyEvidence("all good", "good").ok, true);
});

test("an unverifiable input is declined, not assumed safe", () => {
  const lines: string[] = [];
  for (let i = 0; i < 5000; i++) lines.push("error number " + i);
  const original = lines.join("\n");

  const verdict = verifyEvidenceBounded(original, "error number 0\nerror number 4999");
  assert.equal(verdict.ok, false, "too much evidence to verify must not pass");
  assert.equal(verdict.unverifiable, true);
});

test("repeated identical evidence lines collapse to one check", () => {
  // A log that prints the same error 5000 times is one distinct line, not 5000.
  const original = Array.from({ length: 5000 }, () => "error: disk full").join("\n");
  const verdict = verifyEvidenceBounded(original, "error: disk full");
  assert.equal(verdict.ok, true);
  assert.equal(verdict.unverifiable, undefined);
});

// ---------------------------------------------------------------------------
// test-log detection
// ---------------------------------------------------------------------------

function testLog(passes: number, options: { fail?: boolean; summary?: boolean } = {}) {
  const lines: string[] = [];
  for (let i = 0; i < passes; i++) lines.push("PASS src/case-" + i + ".test.ts");
  if (options.fail !== false) {
    lines.push("FAIL src/auth.test.ts > redirects");
    lines.push("  Expected: 302");
    lines.push("  Received: 200");
    lines.push("    at login (src/auth.ts:42:11)");
  }
  if (options.summary !== false) lines.push("Tests: 1 failed, " + passes + " passed");
  return lines.join("\n");
}

test("a test run is detected", () => {
  assert.equal(detectTestLog(testLog(20)).detected, true);
});

test("prose containing the word PASS is not a test run", () => {
  const prose = "PASS is a word. ".repeat(40);
  assert.equal(detectTestLog(prose).detected, false);
});

test("too few pass lines is not worth a special route", () => {
  assert.equal(detectTestLog(testLog(2)).detected, false);
});

test("a run with no summary or failure signal is not detected", () => {
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) lines.push("PASS case " + i);
  assert.equal(detectTestLog(lines.join("\n")).detected, false);
});

// ---------------------------------------------------------------------------
// test-log reduction
// ---------------------------------------------------------------------------

test("reduction drops passing lines and keeps every failure detail", () => {
  const original = testLog(40);
  const reduced = reduceTestLog(original);

  assert.ok(reduced.dropped >= 40, "should drop the pass lines");
  assert.ok(reduced.text.includes("FAIL src/auth.test.ts"));
  assert.ok(reduced.text.includes("Expected: 302"));
  assert.ok(reduced.text.includes("Received: 200"));
  assert.ok(reduced.text.includes("at login (src/auth.ts:42:11)"));
  assert.ok(reduced.text.includes("Tests: 1 failed"));
  assert.equal(verifyEvidence(original, reduced.text).ok, true);
});

test("reduction is idempotent", () => {
  const once = reduceTestLog(testLog(30));
  const twice = reduceTestLog(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.dropped, 0);
});

test("reduction keeps a green run's summary", () => {
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) lines.push("PASS case " + i);
  lines.push("Tests: 20 passed");
  const reduced = reduceTestLog(lines.join("\n"));
  assert.ok(reduced.text.includes("Tests: 20 passed"));
});

// ---------------------------------------------------------------------------
// end-to-end: the reducer must never ship an evidence-dropping result
// ---------------------------------------------------------------------------

test("reduce keeps failures in a long log", () => {
  const adopted = reduce(testLog(400), options);
  assert.ok(adopted);
  assert.equal(verifyEvidence(testLog(400), adopted.text).ok, true);
});

test("reduce takes the test-log route when it applies", () => {
  const adopted = reduce(testLog(400), options);
  assert.ok(adopted);
  assert.equal(adopted.strategy, "test-log");
  assert.equal(adopted.lossless, false);
});

test("every lossy route the reducer can return preserves evidence", () => {
  const fixtures = [
    testLog(500),
    // A plain log with scattered errors and no test-runner shape.
    Array.from({ length: 800 }, (_, i) => (i % 97 === 0 ? "error at step " + i : "step " + i)).join("\n"),
    // A wide table where the strided sampler applies.
    Array.from({ length: 600 }, (_, i) => "row" + i + "|a|b").join("\n"),
    // Dense prose with one failure buried in the middle.
    Array.from({ length: 900 }, (_, i) =>
      i === 450 ? "FATAL: cannot continue" : "filler line number " + i,
    ).join("\n"),
  ];

  for (let i = 0; i < fixtures.length; i++) {
    const adopted = reduce(fixtures[i], options);
    if (adopted === null) continue;
    const verdict = verifyEvidence(fixtures[i], adopted.text);
    assert.equal(verdict.ok, true, "fixture " + i + " dropped: " + verdict.missing.slice(0, 2).join(" | "));
  }
});

test("reduce is not allowed to save bytes by dropping the only error", () => {
  // 400 noise lines plus exactly one fatal line: the fatal line must survive
  // even though dropping it would save the most.
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) lines.push("progress " + i + " " + "x".repeat(40));
  lines.splice(200, 0, "FATAL: the database is unreachable");
  const original = lines.join("\n");

  const adopted = reduce(original, options);
  if (adopted !== null) {
    assert.ok(adopted.text.includes("FATAL: the database is unreachable"));
  }
});
