# TokenForge

**Cut what an agent carries, not what it can do.**

A context-cost extension for the [pi](https://github.com/earendil-works/pi) coding agent. It applies four techniques, each independently switchable, each reversible, and each gated on a single rule: *a rewrite is only adopted if it is smaller in bytes **and** cheaper in tokens.* Otherwise the original goes out untouched.

---

## The problem

In an agent loop the model re-reads its whole context on every step. The expensive part is rarely what you typed. It is:

- **Tool output** — build logs, test reports, API JSON, CLI tables. Often tens of thousands of characters to deliver a handful of useful lines, and then billed again on every following step.
- **Repeated output** — the same `cat`, the same test run, the same query, re-entering the context verbatim.
- **Stale results** — a file read from forty steps ago that a later read already superseded, still riding along.
- **Skill catalogs** — dozens of descriptions injected at session start, most of them unrelated to the task at hand.

All of it is billed as input, all of it fills the window, and all of it dilutes attention.

---

## The five mechanisms

Four switchable techniques, plus the gate that governs all of them.

### 1. Structured reduction at entry

Tool results are reshaped **once, before they enter the session**. Because this happens before the content is recorded, the transcript prefix stays byte-stable afterwards and the provider's prompt cache keeps hitting — the rewrite is paid for once, not on every request.

Reduction is chosen by shape, not by guessing:

| Input shape | What happens |
|---|---|
| JSON with a uniform array (root, direct child, or `{data:{items:[…]}}` envelope) | Re-encoded as a table: one header line of keys, one CSV line per row. **Zero information loss.** |
| Root map of uniform objects (`{id1:{…}, id2:{…}}`) | Re-encoded as rows with an added leading key column. Lossless. |
| NDJSON / JSONL where every line has one shape | The whole log becomes a single table. Lossless. |
| Pipe/tab-delimited table | Head and tail kept verbatim, middle sampled every N rows **with original line numbers**, so any range can be located again. |
| Long prose or logs | Head/tail window, blank runs collapsed, repeated lines folded into a count, oversized lines trimmed in the middle. |
| JSON too irregular to tabularize | Structural elision: long arrays keep head and tail, wide objects keep the first keys, long strings trimmed — with the omitted shape reported. |

Each route is priced before it is adopted. The lossless route is tried first and wins whenever it clears the gate; lossy elision is only a fallback.

### 2. Never-worse gate

Every candidate must clear three thresholds simultaneously:

- **Ratio** — no larger than 72% of the original (deliberately conservative; aggressive compression has been measured to *raise* cost by degrading task success).
- **Absolute** — at least 500 bytes actually saved, so noise is not counted as gain.
- **Token** — estimated tokens must strictly *decrease*. A byte win that does not reduce tokens is not a win.

Fail any one and the original passes through. This is why the tool never reports "compressed" on something it merely shuffled.

### 3. Cross-turn dedupe

A tool result byte-identical to one seen within the last ten minutes is replaced by a one-line stub naming the earlier result and its id. Fingerprints carry the session, the tool name and the arguments, and hash the **full** strings — a shared 64 KB prefix is not evidence of identical output.

The stub never names an id with nothing behind it: the original is persisted before the cache entry is written.

### 4. Reversible by construction

Nothing is destroyed. Before any rewrite the pristine text is written to disk, and the replacement carries two independent recovery channels:

- the `tokenforge_expand` tool, addressed by the id in the notice;
- the raw file path, readable with any tool you already have.

If persisting fails, the rewrite is abandoned. Reversibility is a precondition, not a best-effort feature — a compression you cannot undo is a deletion.

### 5. Cache-aware history pruning (opt-in)

Old tool results outside a protected tail are replaced by a placeholder that keeps the tool name, the original size and the recovery path. The message itself is **preserved** — deleting it would break tool-call/tool-result pairing that every provider validates.

This is the one operation that rewrites history the provider has already cached, so it is off by default, rate limited, and gated on a context-usage watermark. A batch is committed only when it reclaims enough to be worth the single cache rebuild it costs.

### 6. Per-task skill disclosure

When the catalog is larger than the cap, skills are scored against the current task by name and description overlap — no model call, because a judge model would cost more than the catalog it filters. The most relevant are kept, the rest are dropped for that turn, and the result is deterministic so the prefix does not churn.

The filtered list is written back into the prompt options rather than string-replacing the rendered prompt, so the model still receives a well-formed native catalog.

---

## Measurement, honestly separated

`/tokenforge status` reports two numbers that are routinely conflated:

- **avoided tokens** — an estimate of what the reductions kept out of context
- **billed tokens** — what the provider actually charged, from the usage on every assistant message

The first is a model of a counterfactual. The second is the invoice. Reporting only the first is how a tool ends up claiming "saves 90%" while the bill goes up.

It also reports the **cache hit rate**, which is the sentinel metric: pruning that silently raises the bill shows up there first as a falling percentage. If it drops below 85% while pruning is on, the status output says so and suggests turning pruning off.

No tokenizer is bundled. Estimates are calibrated at roughly 3.8 characters per latin token and 0.75 tokens per CJK character, and they are used only to decide "is this smaller" — never to bill anyone.

---

## Install

TokenForge is a pi extension. It follows pi's standard discovery and switching model.

**From a local checkout** — register it as a package, outside the auto-discovery directory, so it appears in pi's plugin list and can be switched on and off:

```bash
# Layout used by pi 1.3+: ~/.pi/agent/packages/
cp -r pi-tokenforge ~/.pi/agent/packages/pi-tokenforge
```

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": [
    "./packages/pi-tokenforge"
  ]
}
```

**From git, once published:**

```bash
pi install git:github.com/<you>/pi-tokenforge
```

**Auto-discovery** also works if you would rather not use the package list — drop the directory into `~/.pi/agent/extensions/` — but note that a directory must live in exactly one of the two places. Registering the same directory both as an auto-discovered extension *and* as a package loads it twice, because the two paths canonicalize differently.

Verify:

```bash
pi list                          # should show pi-tokenforge
```

Then in a session:

```
/tokenforge status
```

Tested against pi 1.3.0 on Node 24. The extension uses only documented extension APIs — `tool_result`, `context`, `before_agent_start`, `message_end`, `registerTool`, `registerCommand` — so it should track later versions, but that is a claim, not a measurement.

---

## Usage

Nothing to operate once installed. The command is the control surface:

| Command | Effect |
|---|---|
| `/tokenforge` or `/tokenforge status` | Modes, reduction counts, byte savings, avoided vs billed tokens, cache hit rate, cost |
| `/tokenforge on` / `off` | Master switch for all techniques |
| `/tokenforge compress` | Toggle entry reduction |
| `/tokenforge dedupe` | Toggle cross-turn dedupe |
| `/tokenforge prune` | Toggle history pruning |
| `/tokenforge disclose` | Toggle skill catalog filtering |
| `/tokenforge config` | Print the config file path and contents |
| `/tokenforge spill` | Show the spill directory and recent originals |
| `/tokenforge reset` | Zero the counters |

Switches persist to `~/.pi/agent/tokenforge/config.json` (honours `PI_CODING_AGENT_DIR`).

The model also gets one tool, `tokenforge_expand(id)`, to pull back a full original when a notice marks something it needs verbatim.

---

## Configuration

`~/.pi/agent/tokenforge/config.json`. Everything is optional; the defaults are usable as-is.

| Key | Default | Meaning |
|---|---|---|
| `compressEnabled` | `true` | Entry reduction |
| `dedupeEnabled` | `true` | Cross-turn dedupe |
| `pruneEnabled` | `false` | History pruning — opt-in, see the cache note |
| `discloseEnabled` | `true` | Skill catalog disclosure |
| `minSavingBytes` | `500` | Absolute saving the gate demands |
| `keepRatioMax` | `0.72` | Ratio the gate demands |
| `maxLines` / `headLines` / `tailLines` | `240` / `140` / `80` | Window shape for long text |
| `tabularHeadRows` / `tabularTailRows` / `tabularSamples` | `60` / `40` / `50` | Table mode retention and sampling |
| `longLineChars` | `420` | Single-line trim threshold |
| `maxParseBytes` | `524288` | Above this, JSON is not parsed |
| `minTabularRows` | `8` | Rows needed before tabularizing |
| `dedupeTtlMs` | `600000` | Dedupe window |
| `dedupeTtlOverrides` | `{}` | Per-tool TTL; `0` disables dedupe for that tool |
| `exemptTools` | `["read","tokenforge_expand"]` | Never touched |
| `nestedEnabled` | `false` | Reduce nested tool calls (pi keeps those out of the transcript) |
| `keepRecentMessages` | `12` | Protected tail for pruning |
| `minBytes` | `2000` | Pruning size floor |
| `minBatchTokens` | `800` | Reclaim needed before a prune batch commits |
| `maxPerPass` | `6` | Messages one prune pass may touch |
| `pruneWatermarkRatio` | `0.75` | Context fraction that triggers pruning |
| `skillMaxKeep` | `12` | Catalog cap |
| `skillMinKeep` | `5` | Never show fewer than this |
| `noticeFullCount` | `3` | Verbose trailers before the compact form |

### A note on the cache

Prompt caches match by prefix. Entry reduction, dedupe and skill disclosure all act **before** content is recorded, so they change only the newly appended segment — the prefix, and therefore the cache, is untouched.

History pruning is different: it replaces content the provider has already cached, so each batch forces one prefix rebuild. That is why it is off by default, why it is rate limited, and why it only commits when the batch is large enough to amortize the rebuild. `/tokenforge status` shows the cache hit rate precisely so you can see whether it is paying off.

---

## Design constraints

These are enforced, not aspirational:

1. **Reversible.** A failed write means no rewrite. `read` output and the expand tool's own output are never touched.
2. **Lossless first.** A lossless route that clears the gate always beats a lossy one. Lossy notices state what was omitted, by category and count.
3. **Double gate.** Ratio, absolute saving and token count must all improve.
4. **Error protection.** Error output gets a higher size floor, and error-signalling lines inside an omitted region are retained with ±1 line of context — a bare assertion rarely explains itself.
5. **Shape preservation.** Message count and roles never change; pruning replaces content, never removes a message.
6. **Fail open.** Any uncertainty — unparseable JSON, unknown shape, missing usage data, unwritable disk — leaves the original alone.

---

## Verification

Three independent layers, all runnable offline:

```bash
# 1. Pure cores — reducers, gate, estimators, pruning selection, disclosure, metering
npm test

# 2. Host harness — boots index.ts through pi's own loader against a fake host,
#    then drives every hook and the command
node harness/load.mjs

# 3. Runtime audit — boots pi's real DefaultResourceLoader against your live
#    agent dir and reports what would actually load, and any duplicates
node harness/audit.mjs
```

The unit suite covers the gate refusing too-small, too-ratio-heavy and token-negative candidates; tabular plans rejecting mismatched keys, array-valued columns and deep nesting; dedupe fingerprints distinguishing long shared prefixes; pruning keeping the protected tail, skipping images, and never re-pruning a placeholder; and disclosure staying deterministic and order-preserving.

### Measured on a live session

A 400-row JSON table (18,545 bytes) delivered through a `bash` tool call:

```
[tokenforge #… losslessly re-encoded: 18,545 -> 6,968 bytes (~62% smaller),
 zero information loss. Need any omitted detail? Call tokenforge_expand with
 id "…", or read the full original at: …\tokenforge\spill\….txt.]
```

62% smaller, zero information loss, and the model still answered correctly about all 400 rows. The full original was on disk and retrievable.

That is one shape on one workload. Session-level savings depend entirely on how much of your traffic is large tool output delivered straight into context. Workflows that write to a file and read a slice back will barely trigger it — and cost nothing when they do not.

---

## Tags

`pi` · `pi-coding-agent` · `pi-extension` · `token-optimization` · `context-engineering` · `context-compression` · `prompt-caching` · `tool-output` · `dedupe` · `llm` · `ai-agent` · `cli` · `typescript`

---

## License

MIT.
