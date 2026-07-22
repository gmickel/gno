---
satisfies: [R2, R3, R5]
---
# fn-96-cjk-lexical-degradation-benchmark.2 Implement deterministic CJK benchmark lanes

## Description
Deliver implement deterministic cjk benchmark lanes as one implementation-sized increment.

**Size:** M
**Files:** `scripts/cjk-lexical-benchmark.ts`, `src/bench/types.ts`, `src/bench/metrics.ts`, `package.json`, `test/bench/cjk-benchmark.test.ts`

### Approach
- Run production BM25, production hybrid, and diagnostic exact/substring/representation adapters without changing production indexing.
- Emit per-language Recall@5/10, MRR, nDCG@10, zero-result rate, index size/build time, and cold/warm latency with runtime/tokenizer fingerprints.
- Keep heavy runs opt-in while testing schema, determinism, and metric calculations in bun test.

### Investigation targets
**Required** (read before coding):
- `src/bench/types.ts:17-94`
- `src/bench/metrics.ts:102-138`
- `evals/helpers/hybrid-benchmark.ts:70-240`
- `src/store/sqlite/fts5-snowball.ts`

**Optional** (reference as needed):
- `scripts/hybrid-benchmark.ts`
- `evals/helpers/setup-db.ts`

### Key context
- Report each language separately; aggregate metrics may supplement but never hide a failed lane.
- Record cold construction separately from warm query latency.

## Acceptance
- [ ] Unchanged inputs produce canonical JSON and readable Markdown with stable fingerprints.
- [ ] All required per-language metrics, index costs, and cold/warm timings are present.
- [ ] Diagnostic adapters remain benchmark-only and cannot alter production behavior.


## Done summary
Implemented the deterministic CJK lexical degradation benchmark with production BM25, degraded production hybrid with all semantic ports disabled, raw/NFC substring diagnostics, stable fingerprints, per-language metrics/failures, index and latency costs, and dated/latest JSON plus Markdown artifacts.
## Evidence
- Commits: 7f3635e
- Tests: bun test test/bench/cjk*, bun run bench:cjk-lexical -- --write, bun run lint:check, .flow/bin/flowctl validate --spec fn-96-cjk-lexical-degradation-benchmark --json
- PRs: