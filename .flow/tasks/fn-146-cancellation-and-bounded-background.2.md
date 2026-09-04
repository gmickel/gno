---
satisfies: [R1, R6]
---
# fn-146-cancellation-and-bounded-background.2 Propagate cancellation through transports and pipeline

## Description
Propagate cancellation through transports and pipeline. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/serve/server.ts, src/pipeline/expansion.ts, src/llm/native-worker/, src/llm/nodeLlamaCpp/generation.ts, src/mcp/, src/llm/http*.ts, test/serve/native-cancellation.test.ts (new)
**Touches:** [src/serve/server.ts, src/pipeline/expansion.ts, src/llm/native-worker/, src/llm/nodeLlamaCpp/generation.ts, src/mcp/, src/llm/http*.ts, test/serve/native-cancellation.test.ts]

### Approach

- Carry admitted REST signal through query/Ask and expansion; propagate MCP client/job cancellation and SDK caller abort into worker and remote HTTP requests.
- Remove Promise.race-only timeout abandonment. Cancel queued work immediately; cooperative generation aborts natively; noncooperative embed/rank remains leased until settlement or owner-controlled retirement.
- Quarantine a stuck owner from new admissions; only retire when no unrelated active operation can be harmed. Queued requests keep their own deadlines and identity; never replay a failed write or native request.
- Preserve diagnostic/error schemas and update corresponding API/MCP/SDK prose with the behavior change.

### Investigation targets

**Required:**
- `src/serve/server.ts:1137`
- `src/pipeline/expansion.ts:477`
- `src/llm/nodeLlamaCpp/generation.ts`
- `src/serve/resident-request.ts`
- `test/serve/resident-request.test.ts:73`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/serve/native-cancellation.test.ts test/serve/resident-request.test.ts test/llm/inference-cancellation-contract.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Abort before load, during generation/ranking and before response suppresses late publication while capacity reflects actual native work.
- [ ] MCP disconnect and REST abort leave no orphaned request; HTTP adapter cancellation remains HTTP-native.
- [ ] A canceled request cannot clear another caller lease or return successful partial results.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
