---
satisfies: [R2, R3, R4, R5, R6]
---
# fn-109-cjk-lexical-normalization.3 Use identical bounded analysis at index and query time

## Description
Deliver use identical bounded analysis at index and query time as one implementation-sized increment.

**Size:** M
**Files:** `src/ingestion/lexical-analyzer.ts`, `src/store/sqlite/adapter.ts`, `src/pipeline/search.ts`, `src/pipeline/explain.ts`, `test/store/cjk-lexical-search.test.ts`

### Approach
- Apply the selected analyzer identically to index and query input with conservative language/mixed-script detection and neutral fallback.
- Preserve ASCII identifiers, URLs, paths, numbers, emoji, punctuation, malformed Unicode handling, and exact user-visible snippets/line ranges.
- Bound n-gram/segmentation expansion and expose analyzer/fingerprint/fallback only in status/explain/diagnose.

### Investigation targets
**Required** (read before coding):
- `src/ingestion/language.ts`
- `src/store/sqlite/adapter.ts:1364-1510`
- `src/pipeline/search.ts`
- `src/pipeline/explain.ts`

**Optional** (reference as needed):
- `src/pipeline/query-language.ts`
- `src/ingestion/strip.ts`
- `evals/fixtures/cjk-lexical-benchmark/promotion-gates.json`

## Acceptance
- [ ] Index/query analysis is byte-deterministic and version-identical for Chinese/Japanese/Korean/mixed fixtures.
- [ ] ASCII/code/path/URL/number/punctuation and original snippet/line-range fixtures remain exact.
- [ ] Expansion caps and neutral fallback prevent pathological index/query growth.
- [ ] Same-run benchmark evidence stays within the frozen `1.75x` index, `2x` build, and `3x` plus `2 ms` warm-p95 caps.


## Done summary
Not executed: no benchmark-proven analyzer exists. Implementing index/query normalization after the no-ship gate would be unjustified production behavior and could regress identifiers, source fidelity, or index cost without evidence. No production files changed.
## Evidence
- Commits:
- Tests: evals/fixtures/cjk-lexical-benchmark/candidates/2026-07-22-no-ship.json, test/bench/cjk-decision.test.ts
- PRs: