---
satisfies: [R3, R4, R6]
---
# fn-96-cjk-lexical-degradation-benchmark.3 Freeze promotion gates baselines and public caveats

## Description
Deliver freeze promotion gates baselines and public caveats as one implementation-sized increment.

**Size:** M
**Files:** `evals/fixtures/cjk-lexical-benchmark/baseline`, `evals/README.md`, `docs/HOW-SEARCH-WORKS.md`, `docs/CONFIGURATION.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Categorize concrete token-boundary, normalization, mixed-script, identifier, and ranking failures from the committed baseline.
- Freeze per-language minimum lift and Latin/code/identifier plus size/build/warm-latency non-regression caps that fn-109 must satisfy.
- Publish qualified semantic-versus-lexical behavior and link immutable evidence without claiming the future analyzer.

### Investigation targets
**Required** (read before coding):
- `evals/README.md`
- `spec/evals.md`
- `docs/HOW-SEARCH-WORKS.md`
- `docs/CONFIGURATION.md`

**Optional** (reference as needed):
- `README.md`
- `/Users/gordon/work/gno.sh/src/lib/site-content.ts`

## Acceptance
- [ ] Baseline JSON/Markdown is committed with environment and categorized examples.
- [ ] fn-109 has explicit per-language lift and cost/non-regression thresholds, with no implementation selected in advance.
- [ ] Repo and hosted multilingual docs distinguish semantic performance from lexical fallback and link the dated baseline.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
