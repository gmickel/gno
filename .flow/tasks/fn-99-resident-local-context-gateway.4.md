---
satisfies: [R2, R4, R6]
---
# fn-99-resident-local-context-gateway.4 Unify lifecycle health concurrency and client visibility

## Description
Deliver unify lifecycle health concurrency and client visibility as one implementation-sized increment.

**Size:** M
**Files:** `src/serve/status.ts`, `src/serve/routes/api.ts`, `src/cli/commands/serve.ts`, `src/cli/commands/daemon.ts`, `src/serve/public/components/HealthCenter.tsx`, `test/serve/resident-concurrency.test.ts`

### Approach
- Expose resident transport/session/queue/model/index-generation health through CLI, Web, and process-status schemas.
- Exercise concurrent reads, indexing/writes, cancellation, restart, graceful/forced shutdown, and DB recovery with one-writer constraints.
- Present one resident core while preserving direct CLI operation and avoiding a hidden third daemon.

### Investigation targets
**Required** (read before coding):
- `src/serve/status.ts`
- `src/serve/routes/api.ts:732-780`
- `src/cli/program.ts:2587-3250`
- `src/store/sqlite/adapter.ts`

**Optional** (reference as needed):
- `src/serve/public/components/HealthCenter.tsx`
- `src/serve/status-model.ts`
## Acceptance
- [ ] Health shows transport, sessions, queues, warm-model reuse, jobs, and index generation consistently.
- [ ] Concurrent read/write/index/cancel/restart/shutdown fixtures complete without deadlock or corruption.
- [ ] Serve/daemon documentation and UI describe one core with truthful direct-CLI exceptions.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
