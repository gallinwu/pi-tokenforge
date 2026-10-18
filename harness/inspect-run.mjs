/**
 * Inspect a pi json-mode run: list every toolResult, its size, and whether it
 * carries a tokenforge notice. Answers "what did the model actually receive"
 * without guessing from a substring search.
 *
 * Run: node harness/inspect-run.mjs <run.json>
 */

import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node harness/inspect-run.mjs <run.json>");
  process.exit(1);
}

const lines = fs.readFileSync(file, "utf-8").split("\n").filter((line) => line.trim() !== "");
let index = 0;

for (const line of lines) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    continue;
  }

  if (record.type !== "message_start" && record.type !== "message_end") continue;
  const message = record.message;
  if (!message || message.role !== "toolResult") continue;

  const content = Array.isArray(message.content) ? message.content : [];
  const text = content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
  const notice = /\[tokenforge #([0-9a-z]+)/.exec(text);

  console.log(
    [
      String(++index).padStart(3),
      record.type.padEnd(14),
      String(message.toolName ?? "?").padEnd(10),
      String(text.length).padStart(7) + " chars",
      notice ? "notice id=" + notice[1] : "no notice",
    ].join("  "),
  );

  if (notice) {
    const body = text.slice(0, text.indexOf("[tokenforge #"));
    console.log("     body starts: " + JSON.stringify(body.slice(0, 120).replace(/\n/g, "\\n")));
    const passLines = (body.match(/^PASS /gm) || []).length;
    console.log("     PASS lines in body: " + passLines);
    console.log("     body has FAIL: " + body.includes("FAIL "));
    console.log("     body has Expected: " + body.includes("Expected:"));
  }
}
