---
satisfies: [R1, R4, R6]
---
# fn-146-cancellation-and-bounded-background.1 Define abort deadlines and native settlement contracts

## Description
Define abort deadlines and native settlement contracts. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/llm/types.ts, src/llm/native-worker/protocol.ts (from fn-144), test/llm/inference-cancellation-contract.test.ts (new), docs/SDK.md, docs/CONFIGURATION.md
**Touches:** [src/llm/types.ts, src/llm/native-worker/protocol.ts, test/llm/inference-cancellation-contract.test.ts, docs/SDK.md, docs/CONFIGURATION.md]

### Approach

- Add optional abort/deadline carriage without breaking existing port callers; distinguish caller cancellation, timeout and native failure using existing error vocabulary.
- Define configured inferenceTimeout from native execution start; caller deadline also covers queue/load. Native generation receives evaluation signal; embedding/ranking have creation signals only, so retain ownership while evaluation settles.
- Reuse5s drain plus5s abort settlement for resident shutdown, followed by at most1s owned-child forced-exit wait. These are operational shutdown bounds, not a universal query SLA.

### Investigation targets

**Required:**
- `src/llm/types.ts:50`
- `src/pipeline/expansion.ts:477`
- `src/config/types.ts:430`
- `src/serve/resident-runtime.ts:579`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/llm/inference-cancellation-contract.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Contract tests cover queued/native-active/response-pending phases and one settlement.
- [ ] No accepted timeout setting remains ignored; invalid configured values fail existing configuration validation.
- [ ] Document execution versus end-to-end deadline and unsupported mid-inference cancellation honestly.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
