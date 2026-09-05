# Eligible-domain scaling evidence

This is the first, known-vector scaling phase of fn-148.4. It does not complete the task or grant performance/QA acceptance.

## Reproduce

Run from the verified GNO checkout, with a new output label:

```sh
TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn148-vector timeout 600 bun evals/acceptance/eligible-scaling.ts <new-label>
```

The script refuses to overwrite a report and verifies `scaling-manifest.json` before a run. It creates synthetic SQLite files under TMPDIR, outside the repository. They remain available for SQL diagnosis. Fixtures contain no private source material. No GGUF models, GPU inference, network requests or live service are involved.

Pinned corpus sizes: 201, 2,001, 10,001 documents. Each document has one English chunk; every 97th non-target owner is inactive, the final owner alone has the rare tag and lacks the exclusion token. Known 2D vectors are stored and queried through real sqlite-vec. This new fixture leaves fn-143 and fn-148.1 fixture pins unchanged.

The full matrix contains four workloads (broad, rare tag, whole-document exclusion, deny-all scope), three exported retrieval pipelines (lexical/vector/hybrid), K=1/10, one/four independent SQLite connections, and five waves. Four-reader waves overlap asynchronous calls on the same event loop; SQLite execution itself remains synchronous. This models event-loop contention, not parallel worker-thread throughput. Graph, expansion and reranking are disabled so eligibility cost is isolated.

## Oracle and timing boundaries

The reference enumerates all active FTS rows without restrictive filters or a short budget and all stored vector distances without eligibility SQL. Independent generated-fixture predicates select eligible hashes before limits. Public pipeline assembly/scoring is shared between reference and measured calls. Every measured ordered JSON result array must match the reference exactly, including scores, snippets, ranges, provenance and egress lineage. Undefined optional fields are omitted by JSON wire serialization. This proves candidate eligibility equivalence, not an independent proof of all pipeline ranking code.

Oracle enumeration/scoring warms caches before measurements. The first measured wave is retained separately; it is not a cold-start measurement. Each wave records every reader start offset, service duration, response from the common wave start, and a 1ms timer delay. Timer delay includes synchronous SQL and queued microtasks, plus scheduler noise; idle controls are retained. p95 is nearest-rank over a small sample, never a population confidence claim. All raw samples and failures remain available. New captures flush each completed wave and mark unfinished groups explicitly.

`paired-scaling.json` compares 97 completed overlapping groups across old/new query shape. It projects only the validated temporary collection-root prefix in `source.absPath` to a fixed synthetic root; original complete result rows remain in each report. All other result fields compare exactly. This is not the full fn-143 model-input/citation paired gate, which remains host-owned.

## Captures, including failures

- `initial-known-vectors/report.json`: failed harness capture. Canonical fingerprint rejected undefined optional fields before samples. Preserved; not counted as a pass.
- `wire-normalized-known-vectors/report.json`: 201/2,001 matrices complete; 10,001 serial broad lexical captured. Intentionally interrupted when the inherited multi-second stall made repeated four-reader waves wasteful. `interruption.json` records the missing unflushed group. It never counts as zero latency or a passing sample.
- `sql-diagnosis.json` and `diagnose-sql.ts`: exact hot-query predicates, rows, plans and one-shot timings for pre148.2/current/proposed SQL. Only unused outer metadata columns are omitted in this diagnostic query.
- `exists-known-vectors/report.json`: complete 144 groups / 1,800 requests, zero output mismatches or request failures. Runtime source fingerprints and dirty checkout state are recorded. This is an intermediate shared-branch candidate; rerun after final variant integration and a stable candidate commit.

## Root cause and tradeoff

The broad `rowid IN (...)` FTS query is inherited from cb3421f6, before task148.2. It is not a newly introduced broad-query regression. At 10,001 documents the diagnostic old/current forms took 5,071.5/5,060.4ms; the equivalent correlated EXISTS form took 7.50ms with exactly identical ordered URI/raw BM25/snippet rows. The query-plan virtual-table index changes from `0:=M3` to `0:M3`, removing the rowid equality constraint from FTS traversal. The observed scaling is consistent with repeated rowid-constrained match work. No index was added.

The store owner applied the minimal correlated EXISTS change after host approval. Selective rare-tag SQL has a real tradeoff: 1.81ms with IN versus 3.38ms with EXISTS at 10,001 rows in this one-shot diagnostic. Neither number establishes a universal latency bound. Scope and ranking comparisons remain exact.

After the fix, 10,001-document broad K10 four-reader p95 response / max timer delay were: lexical 40.89/39.98ms, vector 73.70/76.64ms, hybrid 135.96/135.08ms. The largest remaining timer delay was 246.28ms for four concurrent hybrid whole-document-exclusion requests. That exhaustive exclusion cost remains an explicit performance-review item. No throughput, cold-start, physical-model or production acceptance is implied.

## Remaining acceptance

Host owns final variant-aware candidate rerun, full project gates, fn-143 paired model-input workloads, native model evidence, CLI/MCP/API/UI driven QA, skill eval and documentation reconciliation. Hosted gno.sh work is queued only after the PR per user instruction. No source behavior or documentation files were edited by this scaling worker; the adapter fix belongs to the store owner.
