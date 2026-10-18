/**
 * Demo: what each route actually does to real input.
 * Run: node --experimental-strip-types harness/demo-routes.mjs
 */

import {
  detectTestLog,
  isEvidenceLine,
  isPassOnlyLine,
  reduceTestLog,
  verifyEvidence,
} from "../src/safety.ts";
import { estimateTokens, planTabular, encodeTabular, findDominantArray } from "../src/reduce.ts";

const options = {
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

const { reduce } = await import("../src/reduce.ts");

function show(title, original) {
  const adopted = reduce(original, options);
  const bytes = new TextEncoder().encode(original).length;
  console.log("\n=== " + title);
  console.log("in : " + bytes + " bytes, ~" + estimateTokens(original) + " tokens");
  if (adopted === null) {
    console.log("out: untouched (no route cleared the gate)");
    return;
  }
  console.log(
    "out: " +
      adopted.after +
      " bytes (~" +
      Math.round((1 - adopted.after / adopted.before) * 100) +
      "%), strategy=" +
      adopted.strategy +
      ", lossless=" +
      adopted.lossless,
  );
  const preview = adopted.text.split("\n").slice(0, 6).join("\n");
  console.log("--- what the model sees (first 6 lines):");
  console.log(preview);
}

// 1. tabular, lossless
const rows = [];
for (let i = 0; i < 300; i++) rows.push({ model: "model-" + i, input: i, output: i * 2 });
show("uniform JSON array -> table", JSON.stringify({ data: { items: rows } }));

// 2. what the plan looks like
{
  const doc = { data: { items: rows } };
  const dominant = findDominantArray(doc, 8);
  const plan = planTabular(dominant.array, 8);
  console.log("\n=== tabular plan");
  console.log("array found at: " + dominant.name + " (rows " + dominant.array.length + ")");
  console.log("columns: " + plan.groups.map((g) => g.header).join(", "));
  console.log("width: " + plan.width);
  console.log("header line: " + encodeTabular(rows.slice(0, 3), plan, dominant.name).split("\n")[0]);
}

// 3. test log
{
  const lines = [];
  for (let i = 0; i < 400; i++) {
    if (i === 211) {
      lines.push("FAIL src/auth.test.ts > login redirects");
      lines.push("  Expected: 302");
      lines.push("  Received: 200");
      lines.push("    at login (src/auth.ts:42:11)");
    } else lines.push("PASS src/case-" + i + ".test.ts");
  }
  lines.push("Tests: 1 failed, 399 passed");
  const original = lines.join("\n");

  const detection = detectTestLog(original);
  console.log("\n=== test log detection");
  console.log(
    "pass lines: " + detection.passLines + " / " + detection.totalLines + " -> detected=" + detection.detected,
  );
  show("test run", original);

  const reduced = reduceTestLog(original);
  console.log("--- dropped " + reduced.dropped + " pass lines, kept " + reduced.kept);
  console.log(
    "--- evidence verdict: " +
      JSON.stringify(verifyEvidence(original, reduced.text).ok ? "all evidence present" : "MISSING"),
  );
}

// 4. prose window with anchor rescue
{
  const lines = [];
  for (let i = 0; i < 900; i++) {
    lines.push(i === 450 ? "FATAL: cannot reach the database" : "processing record " + i);
  }
  show("prose window + anchor rescue", lines.join("\n"));
}

// 5. delimiter table, strided
{
  const lines = [];
  for (let i = 0; i < 600; i++) lines.push("row" + i + "|alpha|beta|gamma");
  show("pipe table -> strided sample", lines.join("\n"));
}

// 6. classification demo
console.log("\n=== evidence classification");
for (const line of [
  "FAIL src/a.test.ts",
  "  Expected: 302",
  "    at login (src/auth.ts:42:11)",
  "Tests: 1 failed, 399 passed",
  "PASS src/a.test.ts",
  "✓ renders",
]) {
  console.log(
    "  " +
      (isEvidenceLine(line) ? "EVIDENCE" : "noise   ") +
      (isPassOnlyLine(line) ? " (droppable)" : "") +
      "  " +
      JSON.stringify(line),
  );
}
