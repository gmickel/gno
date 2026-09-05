---
satisfies: [R1, R3]
---
# fn-144-native-recovery-and-idle-inference.4 Integrate lazy residents and truthful post-idle retrieval

## Description
Integrate lazy residents and truthful post-idle retrieval. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/serve/context.ts, src/serve/resident-request.ts, src/mcp/context.ts, src/pipeline/hybrid.ts, src/store/vector/freshness.ts, test/serve/native-idle-recovery.test.ts (new)
**Touches:** [src/serve/context.ts, src/serve/resident-request.ts, src/mcp/context.ts, src/pipeline/hybrid.ts, src/store/vector/freshness.ts, test/serve/native-idle-recovery.test.ts]

### Approach

- Remove eager dimension-driven model loading where validated stored model metadata is available; empty/new indexes initialize only at first required embedding and report capability separately from loaded state.
- Replace broad reader leases with actual-model ownership spanning load/context/inference/cleanup. Repeated metadata reads must leave model idle deadlines unchanged.
- Handle vector inference failure according to documented fallback/error contracts and set vectorsUsed from actual successful vector work. Legitimate no-match remains distinct from failed embedding.
- Couple API/MCP/resident documentation for observable errors and lazy capability state; preserve field shapes unless an explicit contract change is necessary.

### Investigation targets

**Required:**
- `src/serve/context.ts:130`
- `src/serve/resident-request.ts:103`
- `src/store/vector/freshness.ts:11`
- `src/pipeline/hybrid.ts:249`
- `src/pipeline/hybrid.ts:1208`
- `test/mcp/context-lifecycle.test.ts:133`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/serve/native-idle-recovery.test.ts test/serve/resident-request.test.ts test/serve/resident-runtime.test.ts test/mcp/context-lifecycle.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Actual Ivan-shaped fixture returns identical20results before and after repeated test expiry, with fresh-process control.
- [ ] Metadata polling does not keep models resident; failed reload cannot report empty HTTP200 vectorsUsed=true.
- [ ] Queued/active requests racing expiry do not receive disposed contexts; scope/caller policy stays in parent.

## Done summary
Resident native ownership, lazy model resolution, truthful fallback and post-idle recovery integrated.

Focused48-test resident/IPC gate and20-test startup gate passed with typed lint. Real CUDA and Ivan REST probes each returned eight exact20-result arrays through repeated metadata-polled expiry and fresh-process controls. Ivan equals frozen270c initial results. CUDA owned-child failure returned truthful bm25_only/vectorsUsed=false and recovered on the next request. Live dd38f777 empty-cache startup served REST/MCP lexical requests without model resolution/download/native child; first vector request failed explicitly for its intentionally missing local model.

Physical evidence and source identities are retained under fn144 CUDA/Ivan artifact directories; CPU startup/public responses under fn148/public-lexical. No full child-native transcript, original Ivan expanded/reranked3/3 or complete Ask claim: these remain fn144.5.
## Evidence
- Commits: 7274d5fe, 8330a58a, 23ba2c25, dd38f777
- Tests: TMPDIR=/home/gordon/.cache/agent-tmp/gno-fn144-resident timeout 600 bun test ./test/serve/native-idle-recovery.test.ts ./test/serve/resident-request.test.ts ./test/serve/resident-runtime.test.ts ./test/mcp/context-lifecycle.test.ts ./test/pipeline/hybrid-query-batching.test.ts ./test/llm/native-worker-ports.test.ts ./test/llm/native-worker-protocol.test.ts ./test/llm/native-worker-lifecycle.test.ts — exit 0; 48 pass, 0 fail, 265 assertions, bunx oxlint --type-aware --type-check [22 owned source/test paths] — exit 0; zero warnings/errors, bunx oxfmt [owned changed files] — exit 0, Physical CUDA: eight full 20-result REST arrays equal through two metadata-polled expiry cycles and fresh control; owned-child SIGKILL returns vectorsUsed=false and next request recovers exact results, Physical Ivan: eight full 20-result REST arrays equal to frozen270c baseline, persistent parent and three child generations, 38 metadata polls do not prevent expiry, Live dd38f777 startup: empty cache and missing local model URIs under default policy; REST and HTTP MCP lexical pass without load/download/child; first vsearch returns explicit missing-model error
- PRs: