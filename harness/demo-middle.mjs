/**
 * Demo, part 2: the middle of a windowed result — what the omission marker and
 * the anchor rescue actually look like.
 *
 * Run: node --experimental-strip-types harness/demo-middle.mjs
 */

import { windowLines, strideLines, reduce } from "../src/reduce.ts";

const options = {
  maxLines: 240,
  headLines: 140,
  tailLines: 80,
  headRows: 60,
  tailRows: 40,
  samples: 50,
};

// prose with one fatal buried mid-log
{
  const lines = [];
  for (let i = 0; i < 900; i++) {
    lines.push(i === 450 ? "FATAL: cannot reach the database" : "processing record " + i);
  }
  const out = windowLines(lines, options);
  console.log("=== windowed prose, lines around the omission marker");
  const marker = out.findIndex((line) => line.includes("lines omitted"));
  console.log(out.slice(Math.max(0, marker - 1), marker + 5).join("\n"));
  console.log("");
  console.log("kept " + out.length + " of " + lines.length + " lines");
  console.log("fatal line survived: " + out.some((line) => line.includes("FATAL")));
}

// strided table
{
  const lines = [];
  for (let i = 0; i < 600; i++) lines.push("row" + i + "|alpha|beta|gamma");
  const out = strideLines(lines, options);
  console.log("");
  console.log("=== strided table, lines around the sampler marker");
  const marker = out.findIndex((line) => line.includes("data rows omitted"));
  console.log(out.slice(marker, marker + 5).join("\n"));
  console.log("");
  console.log("kept " + out.length + " of " + lines.length + " lines");
}

// gate rejection: why some big input is left alone
{
  console.log("");
  console.log("=== gate: a case that is rejected on purpose");
  // Shuffled-but-similar lines: nothing to dedupe, nothing to window usefully.
  const lines = [];
  for (let i = 0; i < 260; i++) lines.push("unique-" + i + "-" + Math.abs(Math.sin(i)) * 1e6);
  const text = lines.join("\n");
  const adopted = reduce(text, {
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
  });
  console.log(
    adopted === null
      ? "untouched: 220 lines over a 240-line window means the window saves too little to be worth a rewrite"
      : "reduced to " + adopted.after + " bytes via " + adopted.strategy,
  );
}
