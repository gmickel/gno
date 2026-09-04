---
satisfies: [R2, R4, R6]
---
# fn-144-native-recovery-and-idle-inference.1 Define native worker protocol and ownership failures

## Description
Define native worker protocol and ownership failures. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/llm/native-worker/protocol.ts (new), src/llm/native-worker/errors.ts (new), test/llm/native-worker-protocol.test.ts (new)
**Touches:** [src/llm/native-worker/protocol.ts, src/llm/native-worker/errors.ts, test/llm/native-worker-protocol.test.ts]

### Approach

- Define a closed versioned protocol with request and worker-generation IDs, approved local model descriptors, embedding/reranking/generation operations, capability/dimension metadata and one settlement per request.
- Keep protocol output separate from diagnostics. Start with64 queued logical operations, 8MiB transport frames and64MiB logical operation ceiling; split embedding batches preserving order and reject irreducible oversized requests using existing structured errors. Test multibyte boundaries.
- Use the same protocol for resident and command-lifetime CLI children. Do not expose DB handles, network credentials, downloads or caller authorization to the child. Parent owns policy/model selection; child may only load approved native model paths.

### Investigation targets

**Required:**
- `src/llm/errors.ts:12`
- `src/llm/types.ts:84`
- `src/cli/detach.ts:575`
- `test/mcp/context-lifecycle.test.ts:56`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/llm/native-worker-protocol.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Closed schema rejects unknown version/op/generation, malformed results, over-budget payload and duplicate completion.
- [ ] Protocol preserves full vectors, scores, structured generation schema and errors; no native discovery runs in parent.
- [ ] Record queue/frame limits as internal operational bounds with explicit overload behavior, not retrieval truncation.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
