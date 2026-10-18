/**
 * TokenForge — metering.
 *
 * Separates two numbers that get conflated everywhere:
 *
 *   - *avoided* tokens: an estimate of what the reductions kept out of context
 *   - *billed* tokens: what the provider actually charged, per assistant message
 *
 * They are not interchangeable. Avoided tokens are a model of a counterfactual;
 * billed tokens are the invoice. Reporting only the first is how a tool ends up
 * "saving 90%" while the bill goes up.
 */

export interface BilledTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costTotal: number;
  requests: number;
}

export interface ForgeStats {
  /** Results rewritten before entering the session. */
  reductions: number;
  /** Byte-identical repeats replaced by a stub. */
  dedupes: number;
  /** Results that reached the gate and failed it. */
  rejected: number;
  /** Results skipped before pricing (too small, exempt, image, nested). */
  skipped: number;
  /** Results that could not be persisted and were therefore left alone. */
  unpersisted: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Estimated tokens kept out of context by reductions and dedupes. */
  avoidedTokens: number;
  billed: BilledTotals;
}

export function createStats(): ForgeStats {
  return {
    reductions: 0,
    dedupes: 0,
    rejected: 0,
    skipped: 0,
    unpersisted: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    avoidedTokens: 0,
    billed: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      costTotal: 0,
      requests: 0,
    },
  };
}

export function resetStats(stats: ForgeStats): void {
  const fresh = createStats();
  Object.assign(stats, fresh);
  stats.billed = fresh.billed;
}

/** Fold one assistant message's usage into the billed totals. */
export function recordUsage(stats: ForgeStats, usage: any): boolean {
  if (!usage || typeof usage !== "object") return false;
  const billed = stats.billed;
  billed.input += Number(usage.input) || 0;
  billed.output += Number(usage.output) || 0;
  billed.cacheRead += Number(usage.cacheRead) || 0;
  billed.cacheWrite += Number(usage.cacheWrite) || 0;
  billed.reasoning += Number(usage.reasoning) || 0;
  billed.costTotal += Number(usage.cost?.total) || 0;
  billed.requests += 1;
  return true;
}

/**
 * Cache hit rate over everything the provider served.
 *
 * This is the sentinel metric: reductions that quietly rewrite already-sent
 * history drop this number while "avoided tokens" climbs. If it falls, the tool
 * is trading a cheap cache read for a full-price input.
 */
export function cacheHitRate(billed: BilledTotals): number | null {
  const denominator = billed.input + billed.cacheRead;
  if (denominator <= 0) return null;
  return Math.round((billed.cacheRead / denominator) * 1000) / 10;
}

export function byteSavings(stats: ForgeStats): { saved: number; percent: number } {
  const saved = stats.bytesBefore - stats.bytesAfter;
  const percent = stats.bytesBefore > 0 ? Math.round((saved / stats.bytesBefore) * 1000) / 10 : 0;
  return { saved, percent };
}

export interface StatusLine {
  label: string;
  value: string;
}

/**
 * Build the status readout.
 *
 * `formatInt` is injected so this stays free of presentation imports and can be
 * tested with a plain identity function.
 */
export function statusLines(
  stats: ForgeStats,
  formatInt: (value: number) => string,
  config: { compress: boolean; dedupe: boolean; prune: boolean; disclose: boolean },
): StatusLine[] {
  const savings = byteSavings(stats);
  const hit = cacheHitRate(stats.billed);

  return [
    {
      label: "modes",
      value: [
        "compress " + (config.compress ? "on" : "off"),
        "dedupe " + (config.dedupe ? "on" : "off"),
        "prune " + (config.prune ? "on" : "off"),
        "disclose " + (config.disclose ? "on" : "off"),
      ].join(" · "),
    },
    {
      label: "reductions",
      value:
        formatInt(stats.reductions) +
        " rewritten · " +
        formatInt(stats.dedupes) +
        " deduped · " +
        formatInt(stats.rejected) +
        " rejected by gate · " +
        formatInt(stats.skipped) +
        " skipped" +
        (stats.unpersisted > 0 ? " · " + formatInt(stats.unpersisted) + " unpersisted" : ""),
    },
    {
      label: "bytes",
      value:
        formatInt(stats.bytesBefore) +
        " -> " +
        formatInt(stats.bytesAfter) +
        " (-" +
        savings.percent +
        "%)",
    },
    { label: "avoided", value: formatInt(stats.avoidedTokens) + " tokens (estimate, not billing)" },
    {
      label: "billed",
      value:
        "input " +
        formatInt(stats.billed.input) +
        " · cacheRead " +
        formatInt(stats.billed.cacheRead) +
        " · output " +
        formatInt(stats.billed.output) +
        (stats.billed.reasoning > 0 ? " · reasoning " + formatInt(stats.billed.reasoning) : "") +
        " · " +
        formatInt(stats.billed.requests) +
        " requests",
    },
    { label: "cache hit", value: hit === null ? "n/a" : hit + "%" },
    { label: "cost", value: stats.billed.costTotal.toFixed(4) },
  ];
}
