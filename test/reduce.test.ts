/**
 * Unit suite for the pure cores. No host, no network, no filesystem.
 * Run: node --experimental-strip-types --test test/reduce.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDedupeStub,
  buildNotice,
  collapseBlankRuns,
  collapseRepeatedLines,
  dedupeKey,
  effectiveFloor,
  elideValue,
  encodeTabular,
  estimateTokens,
  findDominantArray,
  fnv1a,
  formatInt,
  gateRoute,
  jsonRoutes,
  keyedMapRows,
  looksTabular,
  ndjsonRoute,
  planTabular,
  reduce,
  strideLines,
  trimOversizedLines,
  utf8Bytes,
  windowLines,
  type ReduceOptions,
} from "../src/reduce.ts";

const baseOptions: ReduceOptions = {
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

function rows(count: number, extra: Record<string, unknown> = {}) {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    out.push({ model: "model-" + i, input: i, output: i * 2, ...extra });
  }
  return out;
}

// ---------------------------------------------------------------------------
// estimators
// ---------------------------------------------------------------------------

test("utf8Bytes counts bytes, not characters", () => {
  assert.equal(utf8Bytes("abc"), 3);
  assert.equal(utf8Bytes("中"), 3);
  assert.equal(utf8Bytes("é"), 2);
});

test("estimateTokens charges CJK denser than latin", () => {
  assert.ok(estimateTokens("中文中文中文中文") > estimateTokens("abcdefghijklmnop"));
});

test("estimateTokens is monotonic in length", () => {
  assert.ok(estimateTokens("a".repeat(400)) > estimateTokens("a".repeat(40)));
});

test("estimateTokens treats an astral char as one CJK unit", () => {
  const one = estimateTokens("😀");
  const two = estimateTokens("😀😀");
  assert.ok(two > one);
});

test("fnv1a is deterministic and separates content", () => {
  assert.equal(fnv1a("abc"), fnv1a("abc"));
  assert.notEqual(fnv1a("abc"), fnv1a("abd"));
  assert.equal(fnv1a("abc").length, 8);
});

test("formatInt groups thousands", () => {
  assert.equal(formatInt(1234567), "1,234,567");
  assert.equal(formatInt(999), "999");
});

// ---------------------------------------------------------------------------
// fingerprints
// ---------------------------------------------------------------------------

test("dedupeKey separates session, tool and content", () => {
  const a = dedupeKey("s1", "bash", "{}", "out");
  assert.notEqual(a, dedupeKey("s2", "bash", "{}", "out"));
  assert.notEqual(a, dedupeKey("s1", "read", "{}", "out"));
  assert.notEqual(a, dedupeKey("s1", "bash", "{}", "out2"));
  assert.equal(a, dedupeKey("s1", "bash", "{}", "out"));
});

test("dedupeKey hashes the whole string, not a prefix", () => {
  const prefix = "x".repeat(70000);
  assert.notEqual(
    dedupeKey("s", "bash", "{}", prefix + "A"),
    dedupeKey("s", "bash", "{}", prefix + "B"),
  );
});

// ---------------------------------------------------------------------------
// tabular encoding
// ---------------------------------------------------------------------------

test("planTabular accepts a uniform flat array", () => {
  const plan = planTabular(rows(10));
  assert.ok(plan);
  assert.equal(plan.width, 3);
});

test("planTabular rejects fewer than minRows", () => {
  assert.equal(planTabular(rows(7)), null);
});

test("planTabular rejects a row with a different key set", () => {
  const array = rows(10);
  array[3] = { model: "x", input: 3 };
  assert.equal(planTabular(array), null);
});

test("planTabular rejects a column containing an array", () => {
  assert.equal(planTabular(rows(10).map((row, i) => ({ ...row, tags: [i] }))), null);
});

test("planTabular supports exactly one nesting level", () => {
  const array: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 10; i++) array.push({ id: i, pos: { x: i, y: i + 1 } });
  const plan = planTabular(array);
  assert.ok(plan);
  assert.equal(plan.width, 3);
  assert.ok(plan.groups.some((group) => group.header === "pos{x,y}"));
});

test("planTabular rejects deeper nesting", () => {
  const array: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 10; i++) array.push({ id: i, pos: { x: { y: i } } });
  assert.equal(planTabular(array), null);
});

test("encodeTabular round-trips every cell", () => {
  const array = rows(10);
  const plan = planTabular(array)!;
  const text = encodeTabular(array, plan, "items");
  assert.ok(text.startsWith("items[10]{model,input,output}:"));
  assert.equal(text.split("\n").length, 11);
  for (let i = 0; i < array.length; i++) {
    assert.ok(text.includes("model-" + i + "," + i + "," + i * 2));
  }
});

test("encodeTabular escapes commas and quotes", () => {
  const array: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 8; i++) array.push({ k: 'a,b"c' });
  const text = encodeTabular(array, planTabular(array)!, "items");
  assert.ok(text.includes('"a,b""c"'));
});

// ---------------------------------------------------------------------------
// document shapes
// ---------------------------------------------------------------------------

test("findDominantArray finds a nested envelope", () => {
  const found = findDominantArray({ ok: true, data: { items: rows(20) } });
  assert.ok(found);
  assert.equal(found.name, "items");
  assert.equal(found.isRoot, false);
});

test("findDominantArray prefers the largest array", () => {
  const found = findDominantArray({ small: rows(9), big: rows(40) });
  assert.ok(found);
  assert.equal(found.name, "big");
});

test("keyedMapRows refuses a key collision", () => {
  const document: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) document["k" + i] = { key: i };
  assert.equal(keyedMapRows(document), null);
});

test("jsonRoutes prefers the lossless route", () => {
  const routes = jsonRoutes(JSON.stringify({ data: { items: rows(20) } }), baseOptions.maxParseBytes);
  assert.ok(routes.length > 0);
  assert.equal(routes[0].lossless, true);
  assert.equal(routes[0].strategy, "tabular-array");
  assert.ok(routes[0].text.includes("items[20]"));
});

test("jsonRoutes re-encodes a keyed map losslessly", () => {
  const document: Record<string, unknown> = {};
  for (let i = 0; i < 12; i++) document["k" + i] = { a: i, b: i * 2 };
  const routes = jsonRoutes(JSON.stringify(document), baseOptions.maxParseBytes);
  assert.equal(routes[0].strategy, "tabular-keyed");
  assert.equal(routes[0].lossless, true);
});

test("jsonRoutes returns nothing for non-JSON", () => {
  assert.deepEqual(jsonRoutes("not json", baseOptions.maxParseBytes), []);
});

test("jsonRoutes respects the parse ceiling", () => {
  assert.deepEqual(jsonRoutes(JSON.stringify(rows(20)), 10), []);
});

// ---------------------------------------------------------------------------
// line reduction
// ---------------------------------------------------------------------------

test("collapseBlankRuns keeps at most one blank", () => {
  assert.deepEqual(collapseBlankRuns(["a", "", "", "", "b"]), ["a", "", "b"]);
});

test("collapseRepeatedLines folds long runs", () => {
  assert.deepEqual(collapseRepeatedLines(["a", "a", "a", "a", "a", "b"]), [
    "a",
    "[x5 identical lines]",
    "b",
  ]);
});

test("trimOversizedLines shortens the middle of a huge line", () => {
  const trimmed = trimOversizedLines(["x".repeat(2000)], 420);
  assert.equal(trimmed.length, 1);
  assert.ok(trimmed[0].length < 500);
  assert.ok(trimmed[0].includes("chars]..."));
});

test("looksTabular needs a real delimiter profile", () => {
  const table: string[] = [];
  for (let i = 0; i < 120; i++) table.push("a|b|c");
  assert.equal(looksTabular(table, 100), true);

  const prose: string[] = [];
  for (let i = 0; i < 120; i++) prose.push("a plain sentence with no delimiters");
  assert.equal(looksTabular(prose, 100), false);
});

test("windowLines keeps error anchors with context", () => {
  const lines: string[] = [];
  for (let i = 0; i < 600; i++) {
    lines.push(i === 300 ? "FAIL src/auth.test.ts" : "PASS case " + i);
  }
  const windowed = windowLines(lines, { maxLines: 240, headLines: 140, tailLines: 80 });
  const text = windowed.join("\n");
  assert.ok(text.includes("FAIL src/auth.test.ts"));
  assert.ok(text.includes("lines omitted"));
  assert.ok(windowed.length < lines.length);
});

test("strideLines annotates original line numbers", () => {
  const lines: string[] = [];
  for (let i = 0; i < 500; i++) lines.push("r" + i + "|x|y");
  const strided = strideLines(lines, { maxLines: 240, headRows: 60, tailRows: 40, samples: 50 });
  const annotated = strided.filter((line) => /^L\d+:/ .test(line));
  assert.ok(annotated.length > 0);
});

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

test("effectiveFloor raises the floor so the ratio gate can pass", () => {
  assert.equal(effectiveFloor(1400, 500, 0.72), Math.ceil(500 / 0.28));
  assert.equal(effectiveFloor(1400, 500, 1), 1400);
});

test("gateRoute rejects a candidate that is not smaller enough", () => {
  const original = "a".repeat(10000);
  const candidate = "a".repeat(9000);
  assert.equal(
    gateRoute({ text: candidate, lossless: false, strategy: "x" }, original, {
      minSavingBytes: 500,
      keepRatioMax: 0.72,
    }),
    null,
  );
});

test("gateRoute rejects a candidate that saves too few bytes", () => {
  const original = "a".repeat(1000);
  assert.equal(
    gateRoute({ text: "a".repeat(700), lossless: false, strategy: "x" }, original, {
      minSavingBytes: 500,
      keepRatioMax: 0.9,
    }),
    null,
  );
});

test("gateRoute accepts a candidate that clears every threshold", () => {
  const original = "a".repeat(10000);
  const adopted = gateRoute({ text: "a".repeat(5000), lossless: true, strategy: "x" }, original, {
    minSavingBytes: 500,
    keepRatioMax: 0.72,
  });
  assert.ok(adopted);
  assert.equal(adopted.lossless, true);
  assert.equal(adopted.before, 10000);
});

test("reduce returns null for tiny input", () => {
  assert.equal(reduce("short", baseOptions), null);
});

test("reduce never returns something larger", () => {
  const prose = "a line of prose without any delimiters\n".repeat(400);
  const adopted = reduce(prose, baseOptions);
  if (adopted !== null) {
    assert.ok(adopted.after <= adopted.before * baseOptions.keepRatioMax);
    assert.ok(estimateTokens(adopted.text) < estimateTokens(prose));
  }
});

test("reduce re-encodes a big JSON table losslessly", () => {
  const document = JSON.stringify({ data: { items: rows(300) } });
  const adopted = reduce(document, baseOptions);
  assert.ok(adopted);
  assert.equal(adopted.lossless, true);
  assert.ok(adopted.text.includes("items[300]"));
});

test("reduce compresses a verbose log and keeps the failure", () => {
  const lines: string[] = [];
  for (let i = 0; i < 600; i++) {
    lines.push(i === 300 ? "FAIL src/auth.test.ts > login redirects" : "PASS case " + i);
  }
  const adopted = reduce(lines.join("\n"), baseOptions);
  assert.ok(adopted);
  assert.ok(adopted.text.includes("FAIL src/auth.test.ts"));
});

test("reduce protects error detail from full elision", () => {
  const document = JSON.stringify({ items: rows(60), error: { message: "x".repeat(5000) } });
  const adopted = reduce(document, baseOptions);
  if (adopted !== null && !adopted.lossless) {
    assert.ok(adopted.text.includes("x".repeat(100)));
  }
});

// ---------------------------------------------------------------------------
// ndjson
// ---------------------------------------------------------------------------

test("ndjsonRoute tables a uniform log", () => {
  const lines: string[] = [];
  for (let i = 0; i < 12; i++) lines.push(JSON.stringify({ ts: i, level: "info" }));
  const route = ndjsonRoute(lines.join("\n"), baseOptions.maxParseBytes);
  assert.ok(route);
  assert.equal(route.lossless, true);
  assert.ok(route.text.startsWith("items[12]{"));
});

test("ndjsonRoute refuses a non-object line", () => {
  const lines: string[] = [];
  for (let i = 0; i < 12; i++) lines.push(JSON.stringify({ ts: i }));
  lines[5] = "[1,2,3]";
  assert.equal(ndjsonRoute(lines.join("\n"), baseOptions.maxParseBytes), null);
});

test("ndjsonRoute refuses a non-uniform shape", () => {
  const lines: string[] = [];
  for (let i = 0; i < 12; i++) lines.push(JSON.stringify(i % 2 ? { a: i } : { b: i }));
  assert.equal(ndjsonRoute(lines.join("\n"), baseOptions.maxParseBytes), null);
});

// ---------------------------------------------------------------------------
// elision
// ---------------------------------------------------------------------------

test("elideValue trims a long array to head and tail", () => {
  const stats = { omittedItems: 0, omittedKeys: 0, trimmedStrings: 0 };
  const result = elideValue(Array.from({ length: 40 }, (_, i) => i), 0, stats) as unknown[];
  assert.ok(result.length < 40);
  assert.ok(stats.omittedItems > 0);
});

test("elideValue keeps more of a protected string", () => {
  const stats = { omittedItems: 0, omittedKeys: 0, trimmedStrings: 0 };
  const result = elideValue({ error: "e".repeat(5000), note: "n".repeat(5000) }, 0, stats) as Record<
    string,
    string
  >;
  assert.ok(String(result.error).length > String(result.note).length);
});

// ---------------------------------------------------------------------------
// notices
// ---------------------------------------------------------------------------

test("buildNotice carries both recovery channels", () => {
  const notice = buildNotice({
    id: "abc123",
    body: "reduced body",
    before: 10000,
    after: 2500,
    lossless: false,
    stats: { omittedItems: 5, omittedKeys: 0, trimmedStrings: 2 },
    locator: "/tmp/spill/abc123.txt",
    verbose: true,
  });
  assert.ok(notice.includes("[tokenforge #abc123"));
  assert.ok(notice.includes("tokenforge_expand"));
  assert.ok(notice.includes("/tmp/spill/abc123.txt"));
  assert.ok(notice.includes("75% smaller"));
  assert.ok(notice.includes("+5 array items"));
});

test("buildNotice compact form keeps id and locator", () => {
  const notice = buildNotice({
    id: "abc123",
    body: "b",
    before: 1000,
    after: 200,
    lossless: true,
    locator: "/tmp/x.txt",
    verbose: false,
  });
  assert.ok(notice.includes("#abc123"));
  assert.ok(notice.includes("/tmp/x.txt"));
  assert.ok(notice.includes("losslessly re-encoded"));
});

test("buildDedupeStub names the id and the age", () => {
  const stub = buildDedupeStub(42, "id1", 2048);
  assert.ok(stub.includes("id1"));
  assert.ok(stub.includes("42s"));
});
