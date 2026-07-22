---
satisfies: [R1, R2, R3, R4]
---
# fn-109-cjk-lexical-normalization.1 Select and record the benchmark-proven lexical representation

## Description
Deliver select and record the benchmark-proven lexical representation as one implementation-sized increment.

**Size:** M
**Files:** `evals/fixtures/cjk-lexical-benchmark/promotion-gates.json`, `evals/fixtures/cjk-lexical-benchmark/candidates`, `evals/fixtures/cjk-lexical-benchmark/decision.md`, `scripts/cjk-lexical-benchmark.ts`, `test/bench/cjk-decision.test.ts`

### Approach
- Evaluate only predeclared benchmark adapters such as Unicode normalization, tailored segmentation, character n-grams, or additive FTS representation against fn-96 gates.
- Record per-language lift, Latin/code/identifier non-regression, index/build/warm-query cost, cross-platform variance, and rollback feasibility.
- Select the smallest passing representation; if none passes, close as no-ship evidence rather than weaken thresholds.

### Investigation targets
**Required** (read before coding):
- `src/store/sqlite/fts5-snowball.ts`
- `src/ingestion/language.ts:255-330`

**Optional** (reference as needed):
- `src/bench/metrics.ts`
- `spec/evals.md`
- `evals/fixtures/cjk-lexical-benchmark/promotion-gates.json`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `evals/fixtures/cjk-lexical-benchmark`
- `scripts/cjk-lexical-benchmark.ts`

## Acceptance
- [ ] Decision artifact links immutable fn-96 comparisons and evaluates every threshold in `promotion-gates.json` without weakening or averaging it.
- [ ] Selected representation passes every required language/cost gate or records an explicit no-ship outcome.
- [ ] No production source/schema behavior changes in this task.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
