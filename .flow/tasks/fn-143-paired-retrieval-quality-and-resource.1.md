---
satisfies: [R2, R5]
---
# fn-143-paired-retrieval-quality-and-resource.1 Freeze acceptance manifests and exact comparison records

## Description
Freeze acceptance manifests and exact comparison records. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** evals/acceptance/manifest.ts (new), evals/acceptance/records.ts (new), evals/acceptance/compare.ts (new), test/eval/acceptance/compare.test.ts (new)
**Touches:** [evals/acceptance/manifest.ts, evals/acceptance/records.ts, evals/acceptance/compare.ts, test/eval/acceptance/compare.test.ts]

### Approach

- Define versioned baseline/candidate identities, fixture hashes, per-case model-input records and explicitly declared intended deltas; normalize only enumerated volatile transport fields.
- Reuse canonical serialization rather than duplicate hashing. Store full ordered deterministic evidence, scores and semantic error state. Separate generated-answer variability from deterministic retrieval/input equality.
- Implement unchanged-control comparison and four independent negative controls: missing result, scope leak, false vectorsUsed success, changed model input. Reject missing manifest fields and incompatible fixture identities.

### Investigation targets

**Required:**
- `evals/agentic/canonical.ts`
- `evals/agentic/runner-contract.ts:15`
- `evals/agentic/types.ts:315`
- `evals/helpers/memory-fixtures.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/eval/acceptance/compare.test.ts test/eval/memory-fixtures.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Comparator accepts identical control and rejects each injected defect independently with a named case and field.
- [ ] Fixed fixture/model identity mismatch fails before candidate scoring; generated-answer stochasticity is not hidden by dropping citations or input comparisons.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
