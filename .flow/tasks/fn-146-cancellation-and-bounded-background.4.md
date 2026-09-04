---
satisfies: [R4, R6]
---
# fn-146-cancellation-and-bounded-background.4 Carry finite shutdown through jobs scheduler and child

## Description
Carry finite shutdown through jobs scheduler and child. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** src/serve/resident-runtime.ts, src/serve/embed-scheduler.ts, src/serve/resident-background-work.ts, src/llm/native-worker/client.ts (from fn-144), test/serve/shutdown-lifecycle.test.ts, docs/DAEMON.md
**Touches:** [src/serve/resident-runtime.ts, src/serve/embed-scheduler.ts, src/serve/resident-background-work.ts, src/llm/native-worker/client.ts, test/serve/shutdown-lifecycle.test.ts, docs/DAEMON.md]

### Approach

- Stop new admission/scheduling first; share one overall drain/abort/forced-exit deadline through jobs and scheduler rather than restarting independent timers or awaiting indefinitely afterward.
- Let parent transactions finish/rollback before store close. After configured drain/settlement budget, terminate only owned native child and fail each affected caller exactly once.
- Keep backlog/checkpoint state discoverable on restart, including shutdown during publication. Use existing signal/exit handling and document finite phases.

### Investigation targets

**Required:**
- `src/serve/resident-runtime.ts:579`
- `src/serve/embed-scheduler.ts:304`
- `test/serve/shutdown-lifecycle.test.ts:3`
- `src/serve/resident-admission.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun test test/serve/shutdown-lifecycle.test.ts test/serve/embed-scheduler.test.ts test/serve/resident-concurrency.test.ts
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] Hung native child and blocked scheduler cannot exceed the configured shutdown phases except explicitly reported OS termination failure.
- [ ] Store closes after write settlement; restart sees all incomplete chunks and no false completed job.
- [ ] Owned process cleanup and existing foreground SIGINT semantics pass.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
