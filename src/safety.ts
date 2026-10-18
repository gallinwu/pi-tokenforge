/**
 * TokenForge — the fidelity policy.
 *
 * This module exists to answer one question mechanically: *did the reduction
 * quietly eat something the model needed?* Heuristics decide what to try; this
 * decides what is allowed to ship.
 *
 * The rule the whole extension is built on:
 *
 *   A reduction may drop a line only if that line is provably noise.
 *   Anything that is evidence of a problem must survive verbatim.
 *
 * "Provably noise" means a passing test line, a progress bar, a separator, a
 * blank run — output whose absence cannot change a conclusion. "Evidence" means
 * a failure, an error, an assertion diff, a stack frame, an exit code or a
 * summary. Dropping one of those is exactly how a token saver makes a model
 * dumber: the model stops seeing the thing it was supposed to fix.
 *
 * Everything here is pure. No I/O, no state.
 */

// ---------------------------------------------------------------------------
// what counts as evidence
// ---------------------------------------------------------------------------

/**
 * Evidence signals. Deliberately broad in one direction only: a false positive
 * costs a few retained lines, a false negative costs a re-run or a wrong fix.
 */
export const EVIDENCE_PATTERN =
  /(fatal|panic|traceback|exception|\berror\b|err:|fail(?:ed|ure|ing)?\b|denied|rejected|refused|timeout|timed out|abort|cannot|can't|unable to|syntax error|assertion|assert|segfault|stack ?trace|exit code [1-9]|non-zero|not found|missing|undefined is not|typeerror|rangeerror|referenceerror|syntaxerror)/i;

/** Lines that are a test runner reporting a failure, in the common dialects. */
export const FAILURE_MARKERS: RegExp[] = [
  /^\s*(?:FAIL|FAILED|FAILURE)\b/,
  /^\s*(?:✗|✘|×|✖)\s/,
  /^\s*\[(?:fail|FAILED|X)\]/,
  /^\s*---\s+FAIL:/, // Go
  /^\s*not ok\s+\d+/, // TAP
  /^\s*\d+\s+(?:failing|failed)\b/i,
  /^\s*Tests?:\s+.*\b(?:failed|failing)\b/i,
];

/** Assertion diffs and stack frames describe the bug; never drop them. */
export const DETAIL_MARKERS: RegExp[] = [
  // Jest/Vitest print the two halves on separate lines, so each side has to
  // match on its own — requiring both on one line misses every real diff.
  /^\s*Expected:/,
  /^\s*Received:/,
  /^\s*expected:/i,
  /^\s*actual:/i,
  /^\s*Expected\b.*\bReceived\b/s,
  /^\s*at\s+\S+\s+\(?[^)]*:\d+:\d+\)?/, // JS/TS stack frame
  /^\s*File\s+"[^"]+",\s+line\s+\d+/, // Python traceback frame
  /^\s*\d+:\s+/, // pytest assertion annotation
  /^\s*[+-]{3}\s/,
  /^\s*@@ .* @@/,
];

/** The run summary — a number here is often the only thing that matters. */
export const SUMMARY_MARKERS: RegExp[] = [
  /^\s*Tests?:\s+.*\b(?:passed|failed)\b/i,
  /^\s*\d+\s+passing\b/i,
  /^\s*Test Suites?:/i,
  /^\s*(?:PASS|FAIL)\s*$/,
  /^\s*\d+\s+passed,\s+\d+\s+failed/i,
  /^\s*(?:ok|FAIL)\s+\S+\s+\d+(?:\.\d+)?s/, // Go package line
];

/** True when a line must survive any reduction, verbatim. */
export function isEvidenceLine(line: string): boolean {
  if (!line || line.trim() === "") return false;
  if (EVIDENCE_PATTERN.test(line)) return true;
  for (const pattern of FAILURE_MARKERS) if (pattern.test(line)) return true;
  for (const pattern of DETAIL_MARKERS) if (pattern.test(line)) return true;
  for (const pattern of SUMMARY_MARKERS) if (pattern.test(line)) return true;
  return false;
}

/** Every evidence line in a text, trimmed, order preserved, duplicates kept. */
export function extractEvidence(text: string): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (isEvidenceLine(lines[i])) out.push(lines[i].trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// the invariant
// ---------------------------------------------------------------------------

export interface EvidenceVerdict {
  ok: boolean;
  /** Evidence lines present in the original but absent from the candidate. */
  missing: string[];
  /**
   * Set when the input carried more distinct evidence than the check will
   * verify. An unverifiable reduction counts as a failure, never a pass:
   * "could not confirm it is safe" must not read as "it is safe".
   */
  unverifiable?: boolean;
}

function normaliseLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Distinct evidence lines, normalised.
 *
 * Deduplicated on purpose: the question is whether the *information* survived,
 * not how many times it was printed. It also collapses the pathological case —
 * a log where every row matches an evidence pattern usually holds a handful of
 * distinct lines repeated thousands of times.
 */
export function extractUniqueEvidence(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!isEvidenceLine(lines[i])) continue;
    const key = normaliseLine(lines[i]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Cap on distinct evidence lines the check verifies.
 *
 * Above this the input is not behaving like a log — it is a table whose columns
 * happen to contain evidence-shaped words, and there is no way to tell which
 * rows matter. The honest answer is "cannot verify", and the caller declines
 * the reduction rather than shipping an unchecked one.
 */
export const MAX_VERIFIABLE_EVIDENCE = 512;

/**
 * Check that a candidate kept every distinct piece of evidence the original
 * carried.
 *
 * Matching is on a normalised form (trimmed, whitespace collapsed) so a
 * reflowed or re-encoded line still counts as present — the point is that the
 * information survived, not the byte layout.
 *
 * This is the difference between "the heuristic should have kept it" and "we
 * verified it did". Apply it to every lossy route.
 */
export function verifyEvidence(original: string, candidate: string): EvidenceVerdict {
  const wanted = extractUniqueEvidence(original);
  if (wanted.length === 0) return { ok: true, missing: [] };
  if (wanted.length > MAX_VERIFIABLE_EVIDENCE) {
    return { ok: false, missing: [], unverifiable: true };
  }

  const haystack = normaliseLine(candidate);
  const missing: string[] = [];
  for (let i = 0; i < wanted.length; i++) {
    if (!haystack.includes(wanted[i])) missing.push(wanted[i]);
  }
  return { ok: missing.length === 0, missing };
}

/** Alias for call sites that read better with "bounded" in the name. */
export const verifyEvidenceBounded = verifyEvidence;

// ---------------------------------------------------------------------------
// test-runner reduction
// ---------------------------------------------------------------------------

/** Lines that are a runner saying "this case passed". Dropping one is safe. */
export const PASS_ONLY_MARKERS: RegExp[] = [
  /^\s*(?:PASS|PASSED)\b/,
  /^\s*(?:✓|✔|√)\s/,
  /^\s*ok\s+\d+/,
  /^\s*\[x\]\s/i,
  /^\s*dotnet\s+test/i,
  /^\s*Passed!\s/i,
  /^\s*test\s+\S+\s+\.\.\.\s+ok\b/i,
];

/**
 * Is this line noise whose absence cannot change a conclusion?
 *
 * Two gates: it must look like a pass line, and it must not also look like
 * evidence. A line that says `PASS` *and* carries an error is treated as
 * evidence — the conservative direction.
 */
export function isPassOnlyLine(line: string): boolean {
  if (!line || line.trim() === "") return false;
  if (isEvidenceLine(line)) return false;
  for (const pattern of PASS_ONLY_MARKERS) if (pattern.test(line)) return true;
  return false;
}

export interface TestLogDetection {
  detected: boolean;
  passLines: number;
  totalLines: number;
  hasSummary: boolean;
}

/**
 * Decide whether a result is a test/build run worth treating specially.
 *
 * Requirements, all of them: enough pass lines to be worth the work, pass lines
 * making up a real share of the log, and at least one summary or failure marker
 * so a prose document that happens to contain the word "PASS" is not mistaken
 * for a test run.
 */
export function detectTestLog(text: string, minPassLines = 6): TestLogDetection {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  let passLines = 0;
  let hasSummary = false;

  for (let i = 0; i < lines.length; i++) {
    if (isPassOnlyLine(lines[i])) passLines++;
    if (isEvidenceLine(lines[i])) hasSummary = true;
  }

  const share = lines.length > 0 ? passLines / lines.length : 0;
  return {
    detected: passLines >= minPassLines && share >= 0.35 && hasSummary,
    passLines,
    totalLines: lines.length,
    hasSummary,
  };
}

export interface TestLogReduction {
  text: string;
  dropped: number;
  kept: number;
}

/**
 * Drop provably-passing lines, keep everything else byte for byte.
 *
 * This is the one lossy transform that cannot remove evidence: the keep set is
 * defined by the evidence predicate, not by a position heuristic. What the model
 * receives is the failures, the diffs, the frame lines and the summary — more
 * signal per token, not less signal.
 */
export function reduceTestLog(text: string): TestLogReduction {
  const lines = text.split("\n");
  const kept: string[] = [];
  let dropped = 0;

  for (let i = 0; i < lines.length; i++) {
    if (isPassOnlyLine(lines[i])) {
      dropped++;
      continue;
    }
    kept.push(lines[i]);
  }

  // Collapse the gap the dropped lines left behind.
  const out: string[] = [];
  let blanks = 0;
  for (let i = 0; i < kept.length; i++) {
    if (kept[i].trim() === "") {
      blanks++;
      if (blanks >= 2) continue;
    } else {
      blanks = 0;
    }
    out.push(kept[i]);
  }

  return { text: out.join("\n"), dropped, kept: out.length };
}
