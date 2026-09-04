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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
