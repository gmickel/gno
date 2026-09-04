---
satisfies: [R5, R6]
---
# fn-146-cancellation-and-bounded-background.5 Exercise cancellation fairness and restart in live QA

## Description
Exercise cancellation fairness and restart in live QA. Implements the mapped requirements using the parent spec contract.

**Size:** M
**Files:** docs/DAEMON.md, docs/API.md, docs/MCP.md, docs/SDK.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-146-cancellation-and-bounded-background/
**Touches:** [docs/DAEMON.md, docs/API.md, docs/MCP.md, docs/SDK.md, ../gno.sh/src/lib/gno-docs.tsx, .flow/artifacts/fn-146-cancellation-and-bounded-background/]

### Approach

- Run real client disconnects, queued/deadline cancellation, background backlog with incoming foreground requests and isolated daemon shutdown/restart.
- Use fn-143 complete results/citation equality against idle baseline; report request latency, cancellation settlement, queue occupancy and native memory with raw samples.
- Reconcile docs already updated in behavior tasks, run full gates and drive any changed hosted pages. Coordinate fn-151 gate fix without reimplementing ReaderGate here.

### Investigation targets

**Required:**
- `docs/DAEMON.md:107`
- `docs/API.md:1031`
- `docs/MCP.md:1569`
- `docs/SDK.md:571`
- `scripts/serve-shutdown-smoke.ts`

### Execution constraints

- Preserve fn-143 fixture identities and use its paired comparator for mechanical equivalence. Scenario-specific additions have new hashes; do not refresh a baseline to hide a failure.
- Couple affected behavior/API documentation to the implementation change. Final QA reconciles prior docs; it does not postpone known contract updates.
- Shared source, migration and hosted-doc files require one editing owner at a time across specs; dependency independence is not permission for overlapping edits.
- Native probes use isolated synthetic state, cached models and one workload per GPU. Never restart the live service or benchmark the private vault.
- No formal plan-review or impl-review. Focused tests and captured running-surface QA remain required.

### Quick commands

```sh
bun run lint:check
bun run typecheck
bun test
bun run docs:verify
bun run smoke:serve-shutdown
```

New test/command paths listed above are deliverables; run them after creating them. Existing investigation paths were verified during planning.

## Acceptance
- [ ] No dropped/duplicated backlog, stale publication, false success or unexplained foreground quality loss.
- [ ] Finite shutdown and resumed backlog observed through actual processes on CUDA and Metal for native paths; missing acceptance remains explicit.
- [ ] Warm/concurrent cost of single-active admission/fairness is evaluated before promotion, not assumed acceptable.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
