---
satisfies: [R2, R3, R6]
---
# fn-97-agentic-retrieval-outcome-benchmark.3 Add comparator and Capsule-prototype adapters

## Description
Deliver add comparator and capsule-prototype adapters as one implementation-sized increment.

**Size:** M
**Files:** `evals/agentic/adapters/lexical.ts`, `evals/agentic/adapters/qmd.ts`, `evals/agentic/adapters/capsule-prototype.ts`, `test/evals/agentic-adapters.test.ts`

### Approach
- Normalize current qmd and lexical-only baselines behind the same task brief and receipt contract.
- Define the Capsule adapter contract and a bounded prototype sufficient to test the one-call evidence-bundle thesis without becoming fn-98 production implementation.
- Mark unsupported comparator capabilities explicitly; never impute missing token/tool data.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/hybrid.ts`
- `/Users/gordon/repos/qmd/README.md`

**Optional** (reference as needed):
- `src/bench/fixture.ts`
- `evals/helpers/retrieval-candidate-benchmark.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `evals/agentic/types.ts`

### Key context
- The prototype validates the contract and selection hypothesis; production schemas/surfaces remain owned by fn-98.

## Acceptance
- [ ] The same validated tasks run against current GNO and at least one lexical/non-GNO comparator.
- [ ] Comparator receipts disclose unsupported/missing measurements instead of fabricating parity.
- [ ] The Capsule prototype returns canonical extractive evidence spans under a global budget.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
