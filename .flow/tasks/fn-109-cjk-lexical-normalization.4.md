---
satisfies: [R2, R3, R4, R5, R6, R7]
---
# fn-109-cjk-lexical-normalization.4 Prove promotion gates rollback packaging and truthful claims

## Description
Deliver prove promotion gates rollback packaging and truthful claims as one implementation-sized increment.

**Size:** M
**Files:** `evals/fixtures/cjk-lexical-benchmark/results`, `test/store/cjk-cross-platform.test.ts`, `docs/HOW-SEARCH-WORKS.md`, `docs/CONFIGURATION.md`, `docs/TROUBLESHOOTING.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Run full fn-96 per-language lift, Latin/code/identifier/mixed non-regression, index/build/warm-latency, migration/rollback, offline, and packaged cross-platform gates.
- Commit dated JSON/Markdown and compare against the frozen decision thresholds.
- Update DB spec, diagnose/status schemas, repo/hosted multilingual claims and rebuild/rollback guidance with measured limits only.

### Investigation targets
**Required** (read before coding):
- `spec/db/schema.sql`
- `docs/HOW-SEARCH-WORKS.md`
- `docs/TROUBLESHOOTING.md`

**Optional** (reference as needed):
- `README.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-comparisons.tsx`
- `scripts/package-smoke.ts`
- `evals/fixtures/cjk-lexical-benchmark/promotion-gates.json`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `evals/fixtures/cjk-lexical-benchmark`

## Acceptance
- [ ] Chinese clears `0.3611`/`0.4722`/`0.3796`/`0.4007` Recall@5/10, MRR, and nDCG@10 with zero-result at most `0.5278`; Japanese clears `0.375` with zero-result at most `0.625`; Korean clears `0.75` with zero-result at most `0.25`; no aggregate hides a failure.
- [ ] Latin/code loss is at most `0.02`, no identifier case regresses, and the frozen `1.75x` size, `2x` build, and `3x` plus `2 ms` p95 caps pass alongside migration/offline/cross-platform/package evidence.
- [ ] Public docs state per-language semantic and lexical results, analyzer/version limits, and rollback guidance accurately.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
