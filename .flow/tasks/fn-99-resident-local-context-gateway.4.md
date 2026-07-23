---
satisfies: [R1, R2, R4, R6]
---
# fn-99-resident-local-context-gateway.4 Unify health and prove concurrent lifecycle correctness

## Description

Expose one safe resident truth surface and prove it remains correct under concurrent work and failure.

**Size:** M
**Files:** `src/serve/status.ts`, `src/serve/status-model.ts`, `src/serve/routes/api.ts`, `src/mcp/http-transport.ts`, `src/mcp/http-session.ts`, `src/cli/detach.ts`, `src/cli/commands/serve.ts`, `src/cli/commands/daemon.ts`, `src/serve/public/components/HealthCenter.tsx`, `spec/output-schemas/process-status.schema.json`, `test/mcp/http-transport.test.ts`, `test/mcp/http-parity.test.ts`, `test/serve/resident-concurrency.test.ts`, `test/serve/resident-health.test.ts`, `test/spec/schemas/process-status.test.ts`

### Approach

- Project only safe status: mode, uptime, admission/shutdown state, active sessions, bounded queues, model lease/load counters, jobs, and monotonic content/index generation. Omit paths, tokens, queries, documents, and caller identifiers.
- Project the HTTP MCP transport's `activeRequests`, `activeSessions`, and `queuedRequests` getters through the resident status model; do not duplicate session accounting outside `HttpMcpSessionStore`.
- Treat `process-status@1.0` as the detached lifecycle truth: both a live `serve` and a live `daemon` report their resident HTTP listener `port`.
- Make CLI, REST, Web/Desktop, and process status derive from the same model and distinguish standalone stdio/direct CLI truthfully.
- Exercise concurrent HTTP/REST reads, indexing/writes, cancellation, disconnect, idle reap, config refresh, model failure, restart, graceful drain, deadline-forced shutdown, and DB recovery/integrity.
- Verify two clients share the runtime/model/store lifecycle while session state and cancellation remain isolated.

### Investigation targets

**Required:** status model/routes/UI, resident runtime, SQLite adapter, model lifecycle, job manager, CLI serve/daemon commands, existing DB integrity helpers.

## Acceptance

- [ ] Every status surface is schema-valid and consistent, including `process-status@1.0` reporting the live serve/daemon listener port; redaction fixtures prove no sensitive state escapes.
- [ ] Two-client warm reuse and monotonic generation metrics prove one resident lifecycle.
- [ ] Concurrent read/write/index/cancel/restart/shutdown matrices complete without deadlock, leaked leases/sessions, or failed DB integrity checks.
- [ ] Serve/daemon expose one owner per data directory; stdio and direct CLI exceptions are explicit.

<!-- Updated by plan-sync: fn-99-resident-local-context-gateway.2 used HttpMcpTransport activeRequests/activeSessions backed by HttpMcpSessionStore -->
<!-- Updated by plan-sync: fn-99-resident-local-context-gateway.3 exposes HttpMcpTransport queuedRequests and process-status@1.0 reports the live daemon HTTP listener port -->

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
