---
satisfies: [R3, R4, R5, R6]
---
# fn-97-agentic-retrieval-outcome-benchmark.4 Publish baselines and enforce Capsule promotion gates

## Description
Deliver publish baselines and enforce capsule promotion gates as one implementation-sized increment.

**Size:** M
**Files:** `evals/agentic/report.ts`, `evals/fixtures/agentic-retrieval/baseline`, `evals/README.md`, `docs/HOW-SEARCH-WORKS.md`, `package.json`

### Approach
- Generate canonical JSON and readable comparison reports with corpus/model/prompt/tool/runtime fingerprints and known limitations.
- Encode accuracy, call-count, context-consumption, claim-span linkage, determinism, and variance gates as machine-checked outcomes.
- Keep generated evaluation opt-in; run fixture/schema/scorer validation in bun test and publish only immutable evidence-backed claims.

### Investigation targets
**Required** (read before coding):
- `evals/README.md`
- `package.json`
- `src/bench/metrics.ts`
- `test/spec/schemas`

**Optional** (reference as needed):
- `docs/HOW-SEARCH-WORKS.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

## Acceptance
- [ ] Committed baseline reports include methodology, environment, raw normalized receipts, and limitations.
- [ ] Promotion fails on any task-accuracy loss, less than 25% call reduction, less than 35% context reduction, under 95% substantive-claim span linkage, or nondeterministic canonical payload.
- [ ] Fixture/schema tests run in bun test; heavyweight agent runs remain explicit opt-in commands.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
