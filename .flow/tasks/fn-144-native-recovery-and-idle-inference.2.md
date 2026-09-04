---
satisfies: [R2, R3, R6]
---
# fn-144-native-recovery-and-idle-inference.2 Implement child ownership and safe native lifecycle

## Description
Implement child ownership and safe native lifecycle. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/llm/native-worker/client.ts (new), src/llm/native-worker/entry.ts (new), src/llm/nodeLlamaCpp/lifecycle.ts, test/llm/native-worker-lifecycle.test.ts (new), test/llm/lifecycle.test.ts
**Touches:** [src/llm/native-worker/client.ts, src/llm/native-worker/entry.ts, src/llm/nodeLlamaCpp/lifecycle.ts, test/llm/native-worker-lifecycle.test.ts, test/llm/lifecycle.test.ts]

### Approach

- Own one child generation, one in-flight startup and exactly-once late-result cleanup; prevent startup/disposal races from publishing stale ownership. Child exits on parent EOF/death and parent fails pending calls exactly once on abnormal exit.
- Implement actual-model lease/timestamp primitives here. Five-minute idle grace starts after native operation and response settlement; metadata does not refresh it. Explicitly dispose backend/model/context before normal retirement, but rely on process exit for native floor reclamation.
- Initially admit one top-level native operation at a time per child with bounded waiting; internal embedBatch retains existing batching. This is a correctness-first operational design, subject to concurrent baseline QA before default promotion; do not silently accept warm throughput regression.

### Investigation targets

**Required:**
- `src/llm/nodeLlamaCpp/lifecycle.ts:169`
- `src/llm/nodeLlamaCpp/lifecycle.ts:212`
- `src/llm/nodeLlamaCpp/lifecycle.ts:460`
- `test/llm/lifecycle.test.ts:195`
- `src/cli/detach.ts:575`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/llm/native-worker-lifecycle.test.ts test/llm/lifecycle.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Concurrent startup creates one child/backend; timeout loser and parent shutdown cannot orphan native ownership.
- [ ] Idle exit is blocked by native work and pending responses; subsequent acquisition starts a valid generation.
- [ ] Adversarial startup/exit/response schedules preserve queue capacity and one-settlement semantics; native stdout cannot corrupt host JSON.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
