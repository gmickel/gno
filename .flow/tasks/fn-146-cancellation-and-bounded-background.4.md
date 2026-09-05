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
Implemented one shared monotonic5s drain+5s abort settlement+up to1s owned-child exit; stop admission/producers before waits, join disposal, fence and roll back unfinished writes before close, retain durable backlog, revoke late callbacks, and return explicit bounded native OS termination failures while retaining unreaped ownership. Existing retirement deadline tightens in place without duplicate kills. Daemon signal registration precedes initial sync; detached parent grace12s. Coupled CLI/configuration/daemon/spec docs describe the event-loop and raw-DB boundaries. Focused final native17/133, runtime/store66/197, expanded156/1507 (overlapping), TSC/typedlint/format/docs green; actual synthetic child and source CLI SIGINT evidence retained in task4-gates. Packaged daemon SIGTERM/native/integrated CUDA+Metal remain task5; no physical claim from mocks. No formal reviews per user.
## Evidence
- Commits: 9bb46bcaebd5fa5bcdea6e1cc6218a8b86c6e977
- Tests: baseline: green - canonical quick command 17 pass / 56 assertions; notes/fn146.4-baseline.log, bun test test/serve/shutdown-lifecycle.test.ts test/serve/embed-scheduler.test.ts test/serve/resident-concurrency.test.ts - included in final verify 37 pass / 173 assertions; notes/fn146.4-final-verify.log, expanded affected regressions 156 pass / 1507 assertions; notes/fn146.4-regressions.log, combined affected verify 122 pass / 461 assertions; notes/fn146.4-verify.log, final focused store/native/runtime/detach 66 pass / 197 assertions; notes/fn146.4-final-focused.log, retirement and cancellation regression 42 pass / 230 assertions; notes/fn146.4-retirement-final.log, bun test test/llm/native-shutdown.test.ts test/llm/native-worker-lifecycle.test.ts - 17 pass / 133 assertions; notes/fn146.4-native-final.log, bun run typecheck - passed; notes/fn146.4-typecheck.log, owned oxlint --type-aware --type-check - 24 TS files, zero warnings/errors; notes/fn146.4-lint.log, owned oxfmt --check - 29 files passed; notes/fn146.4-format-check.log, bun run docs:verify - 15 passed, zero failed, 2 model-cache skips; notes/fn146.4-docs.log
- PRs: