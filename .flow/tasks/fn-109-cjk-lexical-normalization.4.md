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

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `evals/fixtures/cjk-lexical-benchmark`

## Acceptance
- [ ] Every failing CJK lane clears its frozen gate and no aggregate hides a failure.
- [ ] All cost/non-regression/migration/offline/cross-platform/package caps pass with committed evidence.
- [ ] Public docs state per-language semantic and lexical results, analyzer/version limits, and rollback guidance accurately.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
