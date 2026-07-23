---
satisfies: [R1, R2, R3, R4, R6]
---
# fn-99-resident-local-context-gateway.1 Extract the resident ownership, concurrency, and shared MCP surface foundation

## Description

Create the single ownership boundary every resident surface will use before adding a network transport.

**Size:** L
**Files:** `src/serve/resident-runtime.ts`, `src/serve/background-runtime.ts`, `src/serve/context.ts`, `src/serve/jobs.ts`, `src/core/job-manager.ts`, `src/store/sqlite/adapter.ts`, `src/llm/nodeLlamaCpp/lifecycle.ts`, `src/mcp/server.ts`, `src/mcp/context.ts`, `test/serve/resident-runtime.test.ts`, `test/mcp/context-lifecycle.test.ts`, `test/store/adapter.test.ts`

### Approach

- Make `ResidentRuntime` exclusively own the writer coordinator, bounded readers, watcher/scheduler, one shared job manager, model leases, mutable config holder, request admission/cancellation, session counters, monotonic content/index generation, owner lock, and shutdown state.
- Define the serve/daemon ownership matrix: one resident per data directory; a second process fails with a stable owner-status hint. Keep stdio standalone while consuming the same pure MCP surface factory.
- Replace captured config/collection arrays with request-time snapshots. Ensure per-call adapters release leases only and can never call global `ModelManager.disposeAll()`.
- Remove instance-global async SQLite transaction depth; bind transaction ownership to the request/transaction context and preserve one-writer semantics.
- Make shutdown fail-complete: close admission, drain/cancel to a deadline, then settle every cleanup action even if one resource fails.

### Investigation targets

**Required:** `src/serve/background-runtime.ts`, `src/serve/context.ts`, `src/serve/jobs.ts`, `src/core/job-manager.ts`, `src/mcp/server.ts`, `src/mcp/tools/context.ts`, `src/llm/nodeLlamaCpp/lifecycle.ts`, `src/store/sqlite/adapter.ts`, `src/cli/commands/serve.ts`, `src/cli/commands/daemon.ts`.

### Key context

One process may host many transports and sessions; shared ownership never means shared mutable MCP session state. Task 1 must not expose `/mcp`.

## Acceptance

- [ ] Serve/daemon ownership collision, mutable config snapshots, shared jobs, monotonic generations, admission, and all-settled shutdown have focused tests.
- [ ] Shared MCP fixtures preserve stdio tools/resources/results without allowing per-call cleanup to evict warm singleton models.
- [ ] Concurrent transaction tests prove one-writer correctness without instance-global async depth.
- [ ] Repeated model-backed calls retain one warm lifecycle and release every request lease exactly once.

## Done summary
Added the single resident ownership boundary used by serve and daemon, including owner locking, shared jobs/MCP context, request admission, generations, lease-safe warm models, and fail-complete shutdown. Replaced global async SQLite transaction depth with request-bound nesting and serialized outer writers, with focused lifecycle and concurrency regressions.
## Evidence
- Commits: 81918e6c9b20c2c38bad57b5b6520d2ed1e63b50
- Tests: bun run typecheck, bun test test/mcp test/serve test/store, bun run smoke:serve-shutdown, bun run test:package, bun run lint:check, .flow/bin/flowctl validate --spec fn-99-resident-local-context-gateway --json
- PRs: