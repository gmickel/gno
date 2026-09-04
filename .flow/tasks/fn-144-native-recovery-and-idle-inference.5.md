---
satisfies: [R1, R4, R5, R6]
---
# fn-144-native-recovery-and-idle-inference.5 Prove packaged parity and native fault containment

## Description
Prove packaged parity and native fault containment. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** test/llm/native-worker-integration.test.ts (new), scripts/package-smoke-resident.ts, scripts/package-smoke-mcp.ts, evals/fixtures/acceptance/native-lifecycle/ (new), .flow/artifacts/fn-144-native-recovery-and-idle-inference/
**Touches:** [test/llm/native-worker-integration.test.ts, scripts/package-smoke-resident.ts, scripts/package-smoke-mcp.ts, evals/fixtures/acceptance/native-lifecycle/, .flow/artifacts/fn-144-native-recovery-and-idle-inference/]

### Approach

- Run full result/port equality with the fn-143 harness against a packed install, not source-only entrypoints; retain CLI JSON and MCP protocol framing during controlled owned-child failure.
- Exercise startup failure, parent exit, native abnormal exit, oversized batches, restart, structured generation and repeated idle cycles. Preserve queued request identity without replaying the failed request.
- Retrieve and pin the original fn-141 recorded query/model/index configuration from its retained evidence, then run expanded+reranked Ivan case3/3. The superseded spec is evidence only; create no tasks or edits there.

### Investigation targets

**Required:**
- `scripts/package-smoke-resident.ts:425`
- `scripts/package-smoke-mcp.ts:32`
- `scripts/package-smoke-isolation.ts:158`
- `test/serve/shutdown-lifecycle.test.ts:3`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/llm/native-worker-integration.test.ts test/serve/shutdown-lifecycle.test.ts
bun run test:package
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Both CUDA and physical Metal receipts demonstrate actual native behavior; original Metal query succeeds3/3 independently of containment tests.
- [ ] Parent stays alive and native-free after owned-child failure, emits stable structured error and serves a later independent request.
- [ ] Warm concurrent/serial burst comparison reports throughput and complete cold penalty; unexplained steady-state degradation blocks default promotion and requires task-local admission adjustment before completion.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
