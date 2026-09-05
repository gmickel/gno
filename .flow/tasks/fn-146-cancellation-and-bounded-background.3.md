---
satisfies: [R2, R3]
---
# fn-146-cancellation-and-bounded-background.3 Bound background turns and protect foreground service

## Description
Bound background turns and protect foreground service. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/embed/backlog.ts, src/serve/embed-scheduler.ts, src/serve/resident-background-work.ts, src/llm/native-worker/client.ts (from fn-144), test/embed/backlog.test.ts, test/serve/embed-scheduler.test.ts
**Touches:** [src/embed/backlog.ts, src/serve/embed-scheduler.ts, src/serve/resident-background-work.ts, src/llm/native-worker/client.ts, test/embed/backlog.test.ts, test/serve/embed-scheduler.test.ts]

### Approach

- Process at most one existing32-chunk batch per background turn, then release admission and reevaluate demand. Native batch execution is not promised to be preemptible.
- Dispatch foreground first; while background remains pending allow one background batch after at most8 completed foreground native dispatches, resetting fairness after the batch. Preserve bounded queue behavior from fn-144 and measure the resulting foreground cost.
- Revalidate current model/input/owner identity immediately before checkpointing vectors so edit/delete/model change cannot publish stale completion. Keep unprocessed/failing chunks durably pending.
- Consume fn-144 model-specific leases; background embedding must not retain unrelated rerank/generation models. Keep existing debounce/max-wait scheduling and document effective fairness/turn semantics.

### Investigation targets

**Required:**
- `src/embed/backlog.ts:138`
- `src/serve/embed-scheduler.ts:23`
- `src/serve/resident-background-work.ts`
- `src/embed/retry.ts:160`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/embed/backlog.test.ts test/serve/embed-scheduler.test.ts test/embed/retry.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Sustained foreground/background tests show eventual background progress and foreground access between batches.
- [ ] Concurrent input/model mutation prevents late stale vectors; unfinished work resumes exactly once after interruption.
- [ ] No fixed total-query deadline or coverage reduction is introduced to bound a turn.

## Done summary
Implemented bounded32-owner background pages, one shared64-waiter queue with foreground service and eight-inference fairness, current-input/model transactional checkpoint validation, resumable pending work, and independent native model leases. Coupled API/MCP/configuration/architecture/troubleshooting docs included. Focused affected suites green (164/945 expanded; final46/255 fairness/cancellation/ports; counts overlap), typed lint/typecheck/docs green. Actual IPC queue tests and real SQLite mutation/rollback tests satisfy task acceptance. Host accepts queued-native fairness: no credit/reset for metadata, debt retained across preparation gaps, no preemption of active work. Physical CUDA residency runs against immutable44cf in parallel; final integrated CUDA/Metal acceptance and foreground cost remain task5. No formal reviews, per user.
## Evidence
- Commits: 44cf2a1dbd937d97594baf9387374b4b16f98c63
- Tests: baseline: green — bun test test/embed/backlog.test.ts test/serve/embed-scheduler.test.ts test/embed/retry.test.ts, bun test ./test/embed/ ./test/serve/embed-scheduler.test.ts ./test/llm/model-specific-leases.test.ts ./test/llm/embedding.test.ts ./test/llm/native-worker-ports.test.ts ./test/llm/native-worker-lifecycle.test.ts ./test/llm/native-worker-fingerprint-reuse.test.ts ./test/llm/lifecycle.test.ts ./test/llm/native-load-settlement.test.ts ./test/llm/node-rerank-context-size.test.ts ./test/llm/node-rerank-parity.test.ts ./test/serve/native-cancellation.test.ts ./test/serve/inference-transport-cancellation.test.ts ./test/core/job-manager-egress-epoch.test.ts ./test/ingestion/embedding-identity.test.ts ./test/llm/inference-cancellation-contract.test.ts, bun test ./test/llm/native-worker-lifecycle.test.ts ./test/llm/native-worker-fingerprint-reuse.test.ts ./test/llm/native-worker-ports.test.ts ./test/llm/model-specific-leases.test.ts ./test/llm/embedding.test.ts ./test/serve/embed-scheduler.test.ts ./test/embed/variant-backlog.test.ts, bun test ./test/embed/backlog.test.ts ./test/embed/retry.test.ts ./test/embed/background-checkpoints.test.ts, bun run typecheck, bunx oxlint --type-aware --type-check src/llm/inference-scope.ts src/llm/native-worker/owner.ts src/llm/native-worker/client.ts src/llm/native-worker/dispatcher.ts src/llm/nodeLlamaCpp/lifecycle.ts src/llm/nodeLlamaCpp/embedding.ts src/llm/nodeLlamaCpp/generation.ts src/llm/nodeLlamaCpp/rerank.ts src/embed/backlog.ts src/embed/variant-backlog.ts src/embed/batch.ts src/embed/retry.ts src/serve/embed-scheduler.ts src/serve/resident-background-work.ts src/serve/resident-runtime.ts src/core/job-manager.ts src/store/vector/types.ts src/store/vector/lazy.ts src/store/vector/sqlite-vec.ts test/embed/background-checkpoints.test.ts test/embed/variant-backlog.test.ts test/llm/embedding.test.ts test/llm/native-worker-ports.test.ts test/llm/native-worker-lifecycle.test.ts test/llm/model-specific-leases.fixture.ts test/llm/model-specific-leases.test.ts test/serve/embed-scheduler.test.ts test/llm/native-worker-fingerprint-reuse.test.ts, bunx oxfmt --check src/llm/inference-scope.ts src/llm/native-worker/owner.ts src/llm/native-worker/client.ts src/llm/native-worker/dispatcher.ts src/llm/nodeLlamaCpp/lifecycle.ts src/llm/nodeLlamaCpp/embedding.ts src/llm/nodeLlamaCpp/generation.ts src/llm/nodeLlamaCpp/rerank.ts src/embed/backlog.ts src/embed/variant-backlog.ts src/embed/batch.ts src/embed/retry.ts src/serve/embed-scheduler.ts src/serve/resident-background-work.ts src/serve/resident-runtime.ts src/core/job-manager.ts src/store/vector/types.ts src/store/vector/lazy.ts src/store/vector/sqlite-vec.ts test/embed/background-checkpoints.test.ts test/embed/variant-backlog.test.ts test/llm/embedding.test.ts test/llm/native-worker-ports.test.ts test/llm/native-worker-lifecycle.test.ts test/llm/model-specific-leases.fixture.ts test/llm/model-specific-leases.test.ts test/serve/embed-scheduler.test.ts docs/API.md spec/mcp.md docs/TROUBLESHOOTING.md docs/ARCHITECTURE.md docs/CONFIGURATION.md CHANGELOG.md test/llm/native-worker-fingerprint-reuse.test.ts, bun run docs:verify — 15 passed, 2 model-dependent checks skipped, bun test ./test/llm/native-worker-lifecycle.test.ts ./test/serve/native-cancellation.test.ts ./test/llm/native-worker-ports.test.ts, bunx oxlint --type-aware --type-check src/llm/native-worker/owner.ts test/llm/native-worker-lifecycle.test.ts
- PRs: