---
satisfies: [R1, R2, R4, R6]
---
# fn-144-native-recovery-and-idle-inference.3 Route native model ports and command lifetime through child

## Description
Route native model ports and command lifetime through child. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/llm/native-worker/ports.ts (new), src/llm/nodeLlamaCpp/adapter.ts, src/llm/nodeLlamaCpp/embedding.ts, src/llm/nodeLlamaCpp/generation.ts, src/llm/nodeLlamaCpp/rerank.ts, test/llm/native-worker-ports.test.ts (new)
**Touches:** [src/llm/native-worker/ports.ts, src/llm/nodeLlamaCpp/adapter.ts, src/llm/nodeLlamaCpp/embedding.ts, src/llm/nodeLlamaCpp/generation.ts, src/llm/nodeLlamaCpp/rerank.ts, test/llm/native-worker-ports.test.ts]

### Approach

- Return parent proxy ports for native models and construct actual node-llama-cpp ports only inside child. Keep HTTP adapters on their existing path.
- Invalidate embedding worker/tokenizer caches on model/context generation changes. Preserve dimensions, model identity, structured-output capability, vectors and rerank index mapping.
- Use command-lifetime owner disposal for CLI native calls and persistent owner reuse for resident/stdio MCP. Parent-side model selection/cache discovery must avoid native tokenizer/GPU initialization.
- Document affected adapter/SDK semantics with this behavior change; coordinate native files with fn-145, without creating a second reranker process.

### Investigation targets

**Required:**
- `src/llm/nodeLlamaCpp/adapter.ts:71`
- `src/llm/nodeLlamaCpp/embedding.ts:340`
- `src/llm/types.ts:84`
- `test/llm/node-generation-structured.test.ts`
- `src/llm/registry.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/llm/native-worker-ports.test.ts test/llm/embedding.test.ts test/llm/node-generation-structured.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Record/replay equality through fn-143 compares actual port inputs and full deterministic outputs across all operations.
- [ ] Malformed/late/aborted responses cannot become successful vectors or scores; no automatic write replay.
- [ ] Packed entrypoint resolves worker from installed package; HTTP model calls are not accidentally proxied to native child.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
