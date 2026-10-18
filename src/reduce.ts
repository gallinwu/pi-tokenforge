/**
 * TokenForge — pure token-accounting and text-reduction core.
 *
 * No I/O, no host imports, no state. Every function is deterministic:
 * same input -> same output. The host half (index.ts) owns spill files,
 * counters, caches and hooks; everything decidable without a runtime lives
 * here so it can be unit-tested with plain `node --test`.
 *
 * The one rule every reducer obeys: a rewrite is adopted only if it passes
 * the never-worse gate — smaller in bytes AND cheaper in estimated tokens,
 * with an absolute saving worth the churn. Otherwise the original goes out.
 */

import { detectTestLog, reduceTestLog, verifyEvidenceBounded } from "./safety.ts";

// ---------------------------------------------------------------------------
// estimators
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** Exact UTF-8 byte length. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Token estimate without a bundled tokenizer.
 *
 * Calibrated against the mix this tool actually sees: latin prose runs ~3.8
 * chars/token, CJK runs ~1.33 chars/token (0.75 tokens per char). Han,
 * Hiragana/Katakana, Hangul and fullwidth forms are all charged at the CJK
 * rate; a surrogate pair (astral plane) counts as one CJK char, not two.
 *
 * Good enough to decide "is this smaller" — never used to bill anyone.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x2e80 && code <= 0x9fff) {
      cjk++;
    } else if (code >= 0xac00 && code <= 0xd7a3) {
      cjk++; // Hangul syllables
    } else if (code >= 0xff00 && code <= 0xffef) {
      cjk++; // fullwidth forms
    } else if (code >= 0xd800 && code <= 0xdfff) {
      cjk++; // surrogate pair: one astral char
      i++;
    } else {
      other++;
    }
  }
  return Math.ceil(other / 3.8 + cjk * 0.75);
}

/** FNV-1a over the full string. Used for dedupe fingerprints. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return ("0000000" + hash.toString(16)).slice(-8);
}

export function formatInt(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ---------------------------------------------------------------------------
// fingerprints
// ---------------------------------------------------------------------------

/** Stable string form of tool arguments, for fingerprinting. */
export function argsToString(args: unknown): string {
  try {
    return typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/**
 * Dedupe key for a tool result.
 *
 * Carries the owning session so two sessions sharing one process never see
 * each other's "identical to N seconds ago" stub, and hashes the FULL strings
 * — a shared long prefix must never be mistaken for byte-identical output.
 */
export function dedupeKey(
  sessionId: string | undefined,
  toolName: string,
  argsString: string,
  content: string,
): string {
  return [
    sessionId === undefined ? "(none)" : String(sessionId),
    toolName,
    fnv1a(argsString || ""),
    fnv1a(content),
  ].join("|");
}

// ---------------------------------------------------------------------------
// tabular encoding (lossless)
// ---------------------------------------------------------------------------

export function csvCell(value: unknown): string {
  const text = String(value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeHeaderToken(key: unknown): boolean {
  return typeof key === "string" && key !== "" && !/["',{}[\]:\n\r\t]/.test(key);
}

export interface TabularGroup {
  header: string;
  get(row: Record<string, any>): unknown[];
}

export interface TabularPlan {
  groups: TabularGroup[];
  width: number;
}

/**
 * Decide whether an array of objects can become a table with zero information
 * loss.
 *
 * Requirements: at least `minRows` rows; every row carries exactly the same key
 * set (a missing key would render as the literal text "undefined"); every
 * column is uniformly flat primitives/null, or a plain object whose own keys
 * are uniform across all rows (one nesting level only). Arrays anywhere in a
 * column reject the plan — variable-length cells cannot tabularize without loss.
 *
 * Row and key order follow the first row, so the output is deterministic.
 */
export function planTabular(array: unknown[], minRows = 8): TabularPlan | null {
  if (!Array.isArray(array) || array.length < minRows) return null;
  for (let i = 0; i < array.length; i++) {
    if (!isPlainObject(array[i])) return null;
  }
  const rows = array as Record<string, any>[];
  const keys = Object.keys(rows[0]);
  if (keys.length === 0 || keys.length > 24) return null;

  for (let r = 0; r < rows.length; r++) {
    const rowKeys = Object.keys(rows[r]);
    if (rowKeys.length !== keys.length) return null;
    for (let k = 0; k < keys.length; k++) {
      if (!Object.prototype.hasOwnProperty.call(rows[r], keys[k])) return null;
    }
  }

  const groups: TabularGroup[] = [];
  let width = 0;

  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    const first = rows[0][key];

    if (Array.isArray(first)) return null;

    if (first === null || typeof first !== "object") {
      for (let r = 1; r < rows.length; r++) {
        const value = rows[r][key];
        if (value !== null && typeof value === "object") return null;
      }
      groups.push({ header: key, get: (row) => [row[key]] });
      width++;
      continue;
    }

    const subKeys = Object.keys(first);
    if (subKeys.length === 0) return null;
    for (let r = 0; r < rows.length; r++) {
      const value = rows[r][key];
      if (!isPlainObject(value)) return null;
      if (Object.keys(value).length !== subKeys.length) return null;
      for (let s = 0; s < subKeys.length; s++) {
        if (!Object.prototype.hasOwnProperty.call(value, subKeys[s])) return null;
        const cell = value[subKeys[s]];
        if (cell !== null && typeof cell === "object") return null;
      }
    }
    let headerOk = isSafeHeaderToken(key);
    for (let s = 0; s < subKeys.length; s++) {
      if (!isSafeHeaderToken(subKeys[s])) headerOk = false;
    }
    if (!headerOk) return null;

    const captured = subKeys.slice();
    groups.push({
      header: key + "{" + captured.join(",") + "}",
      get: (row) => captured.map((s) => row[key][s]),
    });
    width += captured.length;
  }

  if (width > 64) return null;
  return { groups, width };
}

/**
 * Render rows as `name[N]{col1,col2{a,b}}:` followed by one CSV line per row.
 * Cells are CSV-escaped, so the encoding stays lossless and parseable.
 */
export function encodeTabular(array: unknown[], plan: TabularPlan, name: string): string {
  const rows = array as Record<string, any>[];
  const lines: string[] = [];
  lines.push(name + "[" + rows.length + "]{" + plan.groups.map((g) => g.header).join(",") + "}:");
  for (let r = 0; r < rows.length; r++) {
    const cells: string[] = [];
    for (let g = 0; g < plan.groups.length; g++) {
      const values = plan.groups[g].get(rows[r]);
      for (let v = 0; v < values.length; v++) cells.push(csvCell(values[v]));
    }
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

export interface DominantArray {
  array: unknown[];
  name: string;
  parent: Record<string, any> | null;
  key: string | null;
  isRoot: boolean;
}

/**
 * Find the largest uniform array worth tabularizing: the document itself, a
 * direct property of the root, or a property one level down (the common
 * `{data:{items:[...]}}` envelope). Ties go to the first found in document order.
 */
export function findDominantArray(document: unknown, minRows = 8): DominantArray | null {
  if (Array.isArray(document)) {
    return { array: document, name: "items", parent: null, key: null, isRoot: true };
  }
  if (!isPlainObject(document)) return null;

  let best: DominantArray | null = null;
  const consider = (array: unknown[], name: string, parent: Record<string, any>, key: string) => {
    if (array.length >= minRows && (best === null || array.length > best.array.length)) {
      best = { array, name, parent, key, isRoot: false };
    }
  };

  for (const key in document) {
    const value = document[key];
    if (Array.isArray(value)) consider(value, key, document, key);
  }
  if (best === null) {
    for (const outerKey in document) {
      const child = document[outerKey];
      if (isPlainObject(child)) {
        for (const innerKey in child) {
          const value = child[innerKey];
          if (Array.isArray(value)) consider(value, innerKey, child, innerKey);
        }
      }
    }
  }
  return best;
}

/**
 * Root map whose values are uniform objects (`{id1:{a:1}, id2:{a:2}}`) can be
 * re-encoded as rows with an added leading `key` column. Needs at least
 * `minRows` entries and no `key` collision inside the value objects.
 */
export function keyedMapRows(document: unknown, minRows = 8): Record<string, any>[] | null {
  if (!isPlainObject(document)) return null;
  const keys = Object.keys(document);
  if (keys.length < minRows) return null;
  const rows: Record<string, any>[] = [];
  for (let i = 0; i < keys.length; i++) {
    const value = document[keys[i]];
    if (!isPlainObject(value)) return null;
    if (Object.prototype.hasOwnProperty.call(value, "key")) return null;
    const row: Record<string, any> = { key: keys[i] };
    for (const inner in value) row[inner] = value[inner];
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// line reduction
// ---------------------------------------------------------------------------

/**
 * Error signals worth preserving. Deliberately broad: a missed anchor costs a
 * re-run, a false positive costs a few lines.
 */
export const ERROR_SIGNAL =
  /(fatal|panic|traceback|exception|\berror\b|err:|fail(?:ed|ure|ing)?\b|denied|rejected|timeout|timed out|abort|cannot|unable to|syntax error|assertion|segfault|exit code [1-9])/i;

export function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  let blanks = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      blanks++;
      if (blanks >= 2) continue;
    } else {
      blanks = 0;
    }
    out.push(lines[i]);
  }
  return out;
}

/** Fold runs of more than four identical non-blank lines into a count marker. */
export function collapseRepeatedLines(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const runLength = j - i;
    if (runLength > 4 && lines[i].trim() !== "") {
      out.push(lines[i]);
      out.push("[x" + runLength + " identical lines]");
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out;
}

/** Trim the middle out of pathologically long single lines. */
export function trimOversizedLines(lines: string[], maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.length > maxChars) {
      const head = 260;
      const tail = 100;
      line =
        line.slice(0, head) +
        " ...[+" +
        (line.length - head - tail) +
        " chars]... " +
        line.slice(line.length - tail);
    }
    out.push(line);
  }
  return out;
}

export function delimiterProfile(line: string): string {
  let pipes = 0;
  let tabs = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (ch === "|") pipes++;
    else if (ch === "\t") tabs++;
  }
  return pipes > 0 ? "p" + pipes : tabs > 0 ? "t" + tabs : "x";
}

/**
 * Detect a pipe/tab-delimited table.
 *
 * The dominant delimiter profile must be a real one (`p*`/`t*`) and cover at
 * least 70% of the dense lines, with at least 12 such lines. Accepting
 * dominance of the "no delimiter" profile would silently route prose into the
 * strided sampler, where it loses far more than it should.
 */
export function looksTabular(lines: string[], minRows: number): boolean {
  const dense: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") dense.push(lines[i]);
  }
  if (dense.length < minRows) return false;

  const counts = new Map<string, number>();
  for (let i = 0; i < dense.length; i++) {
    const profile = delimiterProfile(dense[i]);
    counts.set(profile, (counts.get(profile) || 0) + 1);
  }
  let bestCount = 0;
  let bestProfile = "x0";
  counts.forEach((count, profile) => {
    if (count > bestCount) {
      bestCount = count;
      bestProfile = profile;
    }
  });
  return bestProfile.charAt(0) !== "x" && bestCount >= dense.length * 0.7 && bestCount >= 12;
}

export interface WindowOptions {
  maxLines: number;
  headLines: number;
  tailLines: number;
  /** Cap on retained error anchors in the omitted region. */
  maxAnchors?: number;
  /** Context lines kept around each anchor. */
  anchorContext?: number;
}

/**
 * Head/tail window with error-anchor rescue.
 *
 * The omitted middle is not lost silently: up to `maxAnchors` error signals are
 * kept, each widened by `anchorContext` lines on both sides (a bare assertion
 * line rarely explains itself — the test name or stack header next to it is
 * what saves a re-run). Adjacent windows merge. Every retained line carries its
 * original line number so any range can be located again.
 */
export function windowLines(lines: string[], options: WindowOptions): string[] {
  if (lines.length <= options.maxLines) return lines;

  const head = lines.slice(0, options.headLines);
  const tail = lines.slice(lines.length - options.tailLines);
  const middle = lines.slice(options.headLines, lines.length - options.tailLines);
  const maxAnchors = options.maxAnchors ?? 25;
  const context = options.anchorContext ?? 1;

  const anchors: number[] = [];
  for (let i = 0; i < middle.length && anchors.length < maxAnchors; i++) {
    if (ERROR_SIGNAL.test(middle[i])) anchors.push(i);
  }

  const ranges: Array<{ lo: number; hi: number }> = [];
  for (let i = 0; i < anchors.length; i++) {
    const lo = Math.max(0, anchors[i] - context);
    const hi = Math.min(middle.length - 1, anchors[i] + context);
    const previous = ranges[ranges.length - 1];
    if (previous && lo <= previous.hi + 1) {
      if (hi > previous.hi) previous.hi = hi;
    } else {
      ranges.push({ lo, hi });
    }
  }

  const out = head.slice();
  out.push("[... +" + middle.length + " lines omitted ...]");
  if (ranges.length > 0) {
    let kept = 0;
    for (let i = 0; i < ranges.length; i++) kept += ranges[i].hi - ranges[i].lo + 1;
    out.push(
      "[kept " +
        kept +
        " error-related lines (with +-" +
        context +
        " context) from the omitted region, each with its original line number:]",
    );
    for (let i = 0; i < ranges.length; i++) {
      for (let line = ranges[i].lo; line <= ranges[i].hi; line++) {
        out.push("L" + (options.headLines + line + 1) + ": " + middle[line]);
      }
    }
  }
  return out.concat(tail);
}

/**
 * Strided window for tables: keep the first `headRows` and last `tailRows`
 * verbatim, then sample the middle every N rows with original line numbers.
 * The model receives a map with coordinates instead of a blind slice.
 */
export function strideLines(
  lines: string[],
  options: { maxLines: number; headRows: number; tailRows: number; samples: number },
): string[] {
  if (lines.length <= options.maxLines) return lines;

  const middle = lines.slice(options.headRows, lines.length - options.tailRows);
  const stride = Math.max(1, Math.ceil(middle.length / Math.max(1, options.samples)));
  const out = lines.slice(0, options.headRows);
  out.push(
    "[... +" +
      middle.length +
      " data rows omitted; every " +
      stride +
      ". row sampled below with its original line number so any range can be retrieved precisely ...]",
  );
  for (let i = 0; i < middle.length; i += stride) {
    out.push("L" + (options.headRows + i + 1) + ": " + middle[i]);
  }
  return out.concat(lines.slice(lines.length - options.tailRows));
}

export interface LineReduction {
  text: string;
  strategy: "lines" | "lines-strided";
}

export function reduceLines(
  text: string,
  options: WindowOptions & { headRows: number; tailRows: number; samples: number; longLineChars: number },
): LineReduction {
  let lines = collapseBlankRuns(text.split("\n"));
  lines = collapseRepeatedLines(lines);
  lines = trimOversizedLines(lines, options.longLineChars);

  const tabularMinRows = options.headRows + options.tailRows;
  if (looksTabular(lines, tabularMinRows)) {
    return {
      text: strideLines(lines, {
        maxLines: options.maxLines,
        headRows: options.headRows,
        tailRows: options.tailRows,
        samples: options.samples,
      }).join("\n"),
      strategy: "lines-strided",
    };
  }
  return { text: windowLines(lines, options).join("\n"), strategy: "lines" };
}

// ---------------------------------------------------------------------------
// JSON reduction
// ---------------------------------------------------------------------------

export interface ElisionStats {
  omittedItems: number;
  omittedKeys: number;
  trimmedStrings: number;
}

export interface ReductionRoute {
  text: string;
  lossless: boolean;
  strategy: string;
  stats?: ElisionStats;
}

export function isProtectedKey(key: string): boolean {
  return /error|message|stack|fail|fatal|exception|warn/i.test(String(key));
}

function newElisionStats(): ElisionStats {
  return { omittedItems: 0, omittedKeys: 0, trimmedStrings: 0 };
}

/**
 * Structural elision for JSON that cannot be tabularized: long arrays keep
 * head and tail, wide objects keep the first 30 keys, long strings are trimmed.
 * Error-ish keys get a much higher budget so debugging evidence survives.
 */
export function elideValue(value: any, depth: number, stats: ElisionStats): any {
  if (depth > 6) return "[deep]";

  if (Array.isArray(value)) {
    if (value.length > 10) {
      stats.omittedItems += value.length - 5;
      const kept: any[] = [];
      for (let i = 0; i < 3; i++) kept.push(elideValue(value[i], depth + 1, stats));
      kept.push({ __omitted__: "+" + (value.length - 5) + " more items" });
      kept.push(elideValue(value[value.length - 2], depth + 1, stats));
      kept.push(elideValue(value[value.length - 1], depth + 1, stats));
      return kept;
    }
    return value.map((item) => elideValue(item, depth + 1, stats));
  }

  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    const keys = Object.keys(value);
    let index = 0;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      index++;
      if (index > 30) {
        stats.omittedKeys += keys.length - 30;
        out.__omitted_keys__ = "+" + (keys.length - 30) + " more keys";
        break;
      }
      let item = value[key];
      if (typeof item === "string" && item.length > 400 && !isProtectedKey(key)) {
        stats.trimmedStrings++;
        item = item.slice(0, 220) + " ...[+" + (item.length - 300) + " chars]... " + item.slice(item.length - 80);
      } else if (typeof item === "string" && isProtectedKey(key) && item.length > 2000) {
        stats.trimmedStrings++;
        item = item.slice(0, 1800) + " ...[+" + (item.length - 1800) + " chars of error detail truncated]...";
      } else if (item && typeof item === "object") {
        item = elideValue(item, depth + 1, stats);
      }
      out[key] = item;
    }
    return out;
  }
  return value;
}

/**
 * All JSON routes, best first.
 *
 * Order: lossless tabular (root array / dominant array / keyed map), then lossy
 * structural elision, then the NDJSON table. Both tabular and elision are
 * generated up front so the caller can price each one; the lossless candidate
 * is listed first so it wins whenever it clears the gate.
 */
export function jsonRoutes(text: string, maxParseBytes: number, minRows = 8): ReductionRoute[] {
  const trimmed = text.trim();
  if (trimmed.length > maxParseBytes) return [];
  if (trimmed.charAt(0) !== "{" && trimmed.charAt(0) !== "[") return [];

  let document: any;
  try {
    document = JSON.parse(trimmed);
  } catch {
    return [];
  }

  // Price the lossy candidate BEFORE the tabular route mutates the parse.
  let elision: ReductionRoute | null = null;
  const stats = newElisionStats();
  try {
    const reencoded = JSON.stringify(elideValue(document, 0, stats));
    if (typeof reencoded === "string" && reencoded.length >= 20) {
      elision = { text: reencoded, lossless: false, strategy: "elision", stats };
    }
  } catch {
    elision = null;
  }

  const routes: ReductionRoute[] = [];
  let tabular: ReductionRoute | null = null;

  const dominant = findDominantArray(document, minRows);
  if (dominant !== null) {
    const plan = planTabular(dominant.array, minRows);
    if (plan !== null) {
      const parts: string[] = [];
      if (dominant.isRoot) {
        parts.push(encodeTabular(dominant.array, plan, dominant.name));
      } else {
        // Delete the array from a parse we own; the empty wrapper keeps its
        // position, and the rows follow immediately below as a table.
        delete dominant.parent![dominant.key!];
        const remainder = Object.keys(document).length > 0 ? JSON.stringify(document) : "";
        parts.push(remainder);
        parts.push(encodeTabular(dominant.array, plan, dominant.name));
      }
      const encoded = parts.filter((part) => part.length > 0).join("\n");
      if (encoded.length >= 20) {
        tabular = { text: encoded, lossless: true, strategy: "tabular-array" };
      }
    }
  }

  if (tabular === null && isPlainObject(document)) {
    const rows = keyedMapRows(document, minRows);
    if (rows !== null) {
      const plan = planTabular(rows, minRows);
      if (plan !== null) {
        const encoded = encodeTabular(rows, plan, "items");
        if (encoded.length >= 20) {
          tabular = { text: encoded, lossless: true, strategy: "tabular-keyed" };
        }
      }
    }
  }

  if (tabular !== null) routes.push(tabular);
  if (elision !== null) routes.push(elision);
  return routes;
}

/**
 * NDJSON / JSONL route: every line parses as an object with one uniform shape,
 * so the whole log becomes a single table. Streaming logs and `jq -c` dumps hit
 * this instead of the lossy line window.
 */
export function ndjsonRoute(text: string, maxParseBytes: number, minRows = 8): ReductionRoute | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > maxParseBytes) return null;
  if (trimmed.charAt(0) !== "{") return null;

  const lines = trimmed.split("\n");
  const rows: Record<string, any>[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isPlainObject(parsed)) return null;
    rows.push(parsed);
  }
  if (rows.length < minRows) return null;

  const plan = planTabular(rows, minRows);
  if (plan === null) return null;
  const encoded = encodeTabular(rows, plan, "items");
  if (encoded.length < 20) return null;
  return { text: encoded, lossless: true, strategy: "ndjson" };
}

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

export interface GateOptions {
  minSavingBytes: number;
  keepRatioMax: number;
}

export interface AdoptedReduction {
  text: string;
  before: number;
  after: number;
  lossless: boolean;
  strategy: string;
  stats?: ElisionStats;
}

/**
 * Apply the never-worse gate to one candidate.
 *
 * Rejects unless the candidate is at most `keepRatioMax` of the original, saves
 * at least `minSavingBytes` in absolute terms, and is strictly cheaper in
 * estimated tokens. All three, or the original goes out untouched.
 */
export function gateRoute(
  route: ReductionRoute | null,
  original: string,
  options: GateOptions,
): AdoptedReduction | null {
  if (!route) return null;
  const candidate = route.text;
  if (!candidate || candidate.length < 20) return null;

  const before = utf8Bytes(original);
  const after = utf8Bytes(candidate);
  if (after > before * options.keepRatioMax) return null;
  if (before - after < options.minSavingBytes) return null;
  if (estimateTokens(candidate) >= estimateTokens(original)) return null;

  return {
    text: candidate,
    before,
    after,
    lossless: route.lossless === true,
    strategy: route.strategy,
    stats: route.stats,
  };
}

export interface ReduceOptions extends GateOptions {
  maxParseBytes: number;
  maxLines: number;
  headLines: number;
  tailLines: number;
  tabularHeadRows: number;
  tabularTailRows: number;
  tabularSamples: number;
  longLineChars: number;
  minTabularRows: number;
}

/**
 * Route order, first passing candidate wins:
 * test-log reduction -> lossless tabular -> lossy elision -> NDJSON -> line window.
 *
 * Every lossy route must also clear the evidence invariant: a candidate that
 * dropped a failure, an error, an assertion diff, a stack frame or a summary is
 * rejected regardless of how many bytes it saved. That check is what separates
 * this from a truncator — the gate asks "is it smaller", the invariant asks "is
 * it still safe to reason from".
 */
export function reduce(text: string, options: ReduceOptions): AdoptedReduction | null {
  const routes = jsonRoutes(text, options.maxParseBytes, options.minTabularRows);
  const ndjson = ndjsonRoute(text, options.maxParseBytes, options.minTabularRows);
  if (ndjson !== null) routes.push(ndjson);

  // Lossless routes cannot drop evidence; they re-encode. Take one if it fits.
  for (let i = 0; i < routes.length; i++) {
    if (!routes[i].lossless) continue;
    const adopted = gateRoute(routes[i], text, options);
    if (adopted !== null) return adopted;
  }

  // Lossy routes: gate first (cheap), then prove no evidence was lost.
  const lossy: ReductionRoute[] = routes.filter((route) => !route.lossless);

  const detection = detectTestLog(text);
  if (detection.detected) {
    const reduced = reduceTestLog(text);
    lossy.unshift({ text: reduced.text, lossless: false, strategy: "test-log" });
  }

  const lines = reduceLines(text, {
    maxLines: options.maxLines,
    headLines: options.headLines,
    tailLines: options.tailLines,
    headRows: options.tabularHeadRows,
    tailRows: options.tabularTailRows,
    samples: options.tabularSamples,
    longLineChars: options.longLineChars,
  });
  lossy.push({ text: lines.text, lossless: false, strategy: lines.strategy });

  for (let i = 0; i < lossy.length; i++) {
    const adopted = gateRoute(lossy[i], text, options);
    if (adopted === null) continue;
    if (!verifyEvidenceBounded(text, adopted.text).ok) continue;
    return adopted;
  }
  return null;
}

/**
 * The smallest input that could possibly clear the gate: below
 * `minSavingBytes / (1 - keepRatioMax)` no candidate can satisfy both the ratio
 * and the absolute saving, so building one is wasted work.
 */
export function effectiveFloor(minBytes: number, minSavingBytes: number, keepRatioMax: number): number {
  if (keepRatioMax >= 1) return minBytes;
  return Math.max(minBytes, Math.ceil(minSavingBytes / (1 - keepRatioMax)));
}

// ---------------------------------------------------------------------------
// notices
// ---------------------------------------------------------------------------

export interface NoticeInput {
  id: string;
  body: string;
  before: number;
  after: number;
  lossless: boolean;
  stats?: ElisionStats;
  locator: string;
  verbose: boolean;
  hint?: string;
}

/**
 * Reversibility trailer.
 *
 * Verbose form (the first few per process) explains itself in full; later ones
 * use a compact form with the same id and locator. Both keep two recovery
 * channels — the tool and the raw file path — because either one alone can fail
 * for a reason the other does not.
 */
export function buildNotice(input: NoticeInput): string {
  const kind = input.lossless ? " losslessly re-encoded" : " reduced";
  const head =
    "[tokenforge #" +
    input.id +
    kind +
    ": " +
    formatInt(input.before) +
    " -> " +
    formatInt(input.after) +
    " bytes";

  if (!input.verbose) {
    return (
      input.body +
      "\n\n" +
      head +
      '. expand: tokenforge_expand id="' +
      input.id +
      '" | full: ' +
      input.locator +
      "]"
    );
  }

  const percent = Math.round((1 - input.after / input.before) * 100);
  let shape = "";
  if (!input.lossless && input.stats) {
    const parts: string[] = [];
    if (input.stats.omittedItems > 0) parts.push("+" + formatInt(input.stats.omittedItems) + " array items");
    if (input.stats.omittedKeys > 0) parts.push("+" + formatInt(input.stats.omittedKeys) + " object keys");
    if (input.stats.trimmedStrings > 0) parts.push(formatInt(input.stats.trimmedStrings) + " long strings trimmed");
    if (parts.length > 0) shape = " Omitted: " + parts.join(", ") + ".";
  }

  return (
    input.body +
    "\n\n" +
    head +
    " (~" +
    percent +
    "% smaller)" +
    (input.lossless ? ", zero information loss" : "") +
    "." +
    shape +
    ' Need any omitted detail? Call tokenforge_expand with id "' +
    input.id +
    '", or read the full original at: ' +
    input.locator +
    "." +
    (input.hint ? " " + input.hint : "") +
    "]"
  );
}

/** Dedupe stub for a byte-identical repeat inside the TTL window. */
export function buildDedupeStub(ageSeconds: number, id: string, bytes: number): string {
  return (
    "[tokenforge dedupe] This output is byte-identical to a result " +
    Math.max(1, Math.round(ageSeconds)) +
    "s ago (id " +
    id +
    ", " +
    formatInt(bytes) +
    " bytes) and is not repeated here. Refer to that earlier result; call tokenforge_expand with id \"" +
    id +
    '" if you need it verbatim again.'
  );
}
