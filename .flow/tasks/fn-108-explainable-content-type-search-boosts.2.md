---
satisfies: [R1, R2, R3, R5]
---
# fn-108-explainable-content-type-search-boosts.2 Apply one capped boost across retrieval and explain output

## Description
Deliver apply one capped boost across retrieval and explain output as one implementation-sized increment.

**Size:** M
**Files:** `src/pipeline/content-type-boost.ts`, `src/pipeline/search.ts`, `src/pipeline/vsearch.ts`, `src/pipeline/hybrid.ts`, `src/pipeline/explain.ts`, `test/pipeline/content-type-boost.test.ts`

### Approach
- Transform the configured factor into a monotonic post-normalization contribution capped at plus/minus 0.05 before final cutoff/rerank blending.
- Preserve candidate/filter generation and raw/base scores; define a combined affinity-plus-content-type auxiliary cap of 0.08 with stable tie-breaking.
- Expose base score, configured factor, raw/capped contribution, combined auxiliary total, and final score in explain/diagnose.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/search.ts:39-153`
- `src/pipeline/hybrid.ts:659-760`
- `src/pipeline/explain.ts`
- `src/pipeline/diagnose.ts`

**Optional** (reference as needed):
- `src/pipeline/rerank.ts`
- `src/pipeline/filters.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/pipeline/project-affinity.ts`

### Key context
- Boost cannot create candidates, bypass filters/egress, or let stacked metadata signals dominate base relevance.

## Acceptance
- [ ] BM25/vector/hybrid use one scorer and preserve deterministic raw/base/final values.
- [ ] Boost contribution never exceeds 0.05 and combined affinity/boost contribution never exceeds 0.08.
- [ ] Keyword-stuffed/irrelevant boosted candidates cannot overtake clearly relevant evidence beyond the declared cap.


## Done summary
Implemented one shared bounded content-type ranking signal across BM25, vector,
and hybrid retrieval.

- Added monotonic factor-to-contribution scoring capped at +/-0.05.
- Composed content-type scoring with project affinity under the existing
  combined +/-0.08 auxiliary cap.
- Applied scoring only after normalized/blended relevance exists, before final
  cutoff and ordering; candidate generation and filters remain unchanged.
- Added stable tie ordering and exact neutral/missing-rule no-op behavior.
- Added non-enumerable scoring metadata plus explain and diagnose projections
  for base/raw/factor/contribution/combined/final values.
- Refreshed the closed project-affinity provenance receipt because
  `src/pipeline/vsearch.ts` is part of that benchmark's implementation
  fingerprint; the authoritative agentic benchmark remains green.

Implementation commit: `8fad413`

Verification:

- `bun run lint:check`
- `bun test test/config/content-types* test/pipeline/content-type-boost*`
- `bun test test/eval/agentic/baseline.test.ts test/config/content-types* test/pipeline/content-type-boost* test/pipeline/diagnose.test.ts`
- `bun run eval:agentic`
- `.flow/bin/flowctl validate --spec fn-108-explainable-content-type-search-boosts --json`

Baseline note: the first pre-edit focused command was red because the
task-owned `test/pipeline/content-type-boost*` target did not exist. The first
full-suite run later isolated one expected provenance mismatch after changing
`vsearch.ts`; refreshing the receipt fixed it, and the focused authoritative
baseline plus the full agentic benchmark passed.
## Evidence
- Commits: 8fad413
- Tests: bun run lint:check, bun test test/config/content-types* test/pipeline/content-type-boost*, bun test test/eval/agentic/baseline.test.ts test/config/content-types* test/pipeline/content-type-boost* test/pipeline/diagnose.test.ts, bun run eval:agentic, .flow/bin/flowctl validate --spec fn-108-explainable-content-type-search-boosts --json
- PRs: