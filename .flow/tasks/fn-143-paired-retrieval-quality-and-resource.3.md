---
satisfies: [R1, R2, R6]
---
# fn-143-paired-retrieval-quality-and-resource.3 Add cached-model retrieval and verified-answer adapters

## Description
Add cached-model retrieval and verified-answer adapters. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** evals/acceptance/native-adapter.ts (new), evals/acceptance/surface-adapter.ts (new), test/eval/acceptance/adapters.test.ts (new)
**Touches:** [evals/acceptance/native-adapter.ts, evals/acceptance/surface-adapter.ts, test/eval/acceptance/adapters.test.ts]

### Approach

- Reuse native pipeline wiring while explicitly disabling downloads and model substitution; the candidate benchmark permits downloads and must not be invoked unchanged.
- Capture actual embedding/reranking/hybrid and verified Ask inputs/outputs via SDK and owned public surfaces. Preserve caller/model identity and classify unavailable native capability as incomplete.
- Support a record/replay deterministic adapter for comparator unit tests; actual native acceptance must carry a real-model receipt, never a replay receipt.

### Investigation targets

**Required:**
- `evals/helpers/retrieval-candidate-benchmark.ts:24`
- `evals/agentic/verified-ask-contract.ts`
- `evals/agentic/verified-ask-outcome.ts`
- `src/sdk/client.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/eval/acceptance/adapters.test.ts test/eval/agentic/verified-ask-outcome.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Missing cached model, unavailable Metal/CUDA and skipped verification produce incomplete coverage, not PASS.
- [ ] Actual model inputs and cited evidence survive record serialization unchanged; remote or paid judge is not required.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
