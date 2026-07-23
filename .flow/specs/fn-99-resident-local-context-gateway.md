# fn-99 Resident Local Context Gateway

## Goal & Context
<!-- scope: business -->

Give local agent clients one always-warm GNO context service. `gno serve` and `gno daemon` become mutually exclusive modes of the same resident runtime per data directory, so REST, Web, MCP, watchers, jobs, stores, and models share one observable lifecycle instead of reloading or competing.

## Architecture & Data Models
<!-- scope: technical -->

Introduce one `ResidentRuntime` that exclusively owns the store/writer coordinator, bounded readers, watcher and scheduler, shared `JobManager`, `ModelManager` leases, mutable configuration holder, session metrics, request admission/cancellation registry, monotonic content/index generation, and graceful shutdown. Startup acquires a per-data-directory ownership lock; a second `serve` or `daemon` process fails with an owner-status hint rather than silently opening another runtime.

`gno serve` hosts Web UI, REST, and `/mcp`; `gno daemon` hosts headless REST and `/mcp`. Stdio remains a standalone process but consumes the same pure MCP surface factory and contracts. Each HTTP session receives its own `McpServer` and `WebStandardStreamableHTTPServerTransport`; only immutable tool definitions and resident ports are shared. Per-call adapters borrow model leases and may never dispose the singleton `ModelManager`.

Use stable `@modelcontextprotocol/sdk` 1.29.x Web Standard transport with Bun `Request`/`Response`. Resumption is explicitly unsupported in this release (`EventStore` omitted). A shutdown admission gate rejects new work, cancels or drains admitted work to a deadline, then closes all owned resources via `allSettled` semantics.

## API Contracts
<!-- scope: technical -->

- `gno serve` and `gno daemon` expose `/mcp` by default on literal `127.0.0.1`; `::1` is available only through explicit binding unless dual listeners are implemented and tested.
- POST/GET/DELETE follow MCP 2025-11-25 session and protocol-version rules; every post-initialize request carries `Mcp-Session-Id`. Terminated or unknown sessions return stable protocol errors. No resumable delivery is advertised.
- HTTP MCP is read-only by default. Authentication proves caller identity but never grants mutation; write authorization is a separate explicit opt-in.
- External security middleware runs before body parsing and SDK dispatch for every method. It validates the actual peer from Bun `requestIP`, exact Host and Origin allowlists, bearer tokens for non-loopback, body/rate/session/queue limits, and ignores forwarded headers.
- Stable bounded failures: `401` unauthenticated, `403` disallowed peer/Host/Origin/write, `413` oversized body including chunked input, `429` request/session pressure, `503` shutdown or unavailable resident runtime.
- Additive health/status schemas expose safe resident mode, uptime, sessions, queue/admission state, warm-model lease/load counters, job state, content/index generation, and degraded capabilities without paths, tokens, queries, or document content.

## Edge Cases & Constraints
<!-- scope: technical -->

- Loopback does not waive Host/Origin validation; DNS rebinding remains in scope.
- Wildcard or non-loopback binding fails closed without an explicit token file and exact allowlists. Token files use restrictive permissions; rotation/revocation invalidates existing authenticated sessions.
- Never trust `Forwarded` or `X-Forwarded-*` headers. No proxy mode in this release.
- Bounded chunked bodies must be rejected before the SDK sees them. Session IDs are cryptographically random visible ASCII and never accepted from a different authenticated caller.
- Mutable config refreshes atomically for new requests; sessions cannot retain stale collection/config arrays indefinitely.
- SQLite transaction ownership cannot use instance-global async depth. Concurrent reads/indexing and cancellation must preserve one-writer correctness and pass integrity checks.
- Disconnect, idle reap, model failure, SIGINT/SIGTERM, startup collision, restart, and forced shutdown release every lease/session once without stopping cleanup after the first error.
- Packaged npm and desktop paths require smoke coverage. macOS/Windows client artifact builds are nonblocking during per-feature landing and join the consolidated final green sweep.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Two independent HTTP MCP clients concurrently use one resident process, store generation, job manager, and model lifecycle; session state is isolated.
- **R2:** Repeated calls share warm embedding/rerank/generation models without global disposal from per-call cleanup; lease/load counters prove reuse.
- **R3:** Stdio and HTTP MCP expose contract-equivalent tools/resources and results from shared fixtures while retaining their distinct process lifecycles.
- **R4:** Concurrent reads, writes/indexing, cancellation, disconnect, idle reap, restart, and graceful/forced shutdown pass without deadlock or DB corruption.
- **R5:** Default binding is safe loopback; actual-peer, Host, Origin, token, body, rate, queue, and session adversarial tests fail closed with stable redacted responses.
- **R6:** Serve, daemon, CLI status, Web/Desktop health, schemas, and docs describe one resident core per data directory and a truthful standalone stdio/direct-CLI exception.
- **R7:** Packed npm and desktop-compatible smokes cover two-client MCP, warm reuse, security, restart, and shutdown on supported systems; hosted docs ship with the feature.

## Boundaries
<!-- scope: business -->

No remote OAuth, team tenancy, cloud relay, trusted proxy mode, multi-user authorization, CLI client/server conversion, automatic second-process attach, resumable MCP event storage, or third resident daemon.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Operational simplicity and warm reuse are qmd's clearest advantages. A shared gateway removes repeated model loading and competing local lifecycles while making GNO's broader evidence capabilities easier for several agents to consume.

### Implementation Tradeoffs
<!-- scope: technical -->

A mutually exclusive owner per data directory is simpler and safer than automatic process attachment. Stable MCP SDK 1.29 provides Bun-compatible Web Standard transport without adopting the still-beta v2 package split. Explicitly omitting resumption avoids claiming delivery guarantees GNO does not persist yet.

## Implementation Plan

1. `fn-99-resident-local-context-gateway.1` — Extract the resident ownership, concurrency, and shared MCP surface foundation (**L**)
2. `fn-99-resident-local-context-gateway.2` — Add isolated Streamable HTTP MCP sessions behind a disabled/test-only route (**M**); depends on `fn-99-resident-local-context-gateway.1`
3. `fn-99-resident-local-context-gateway.3` — Enforce the network security and authorization contract, then enable `/mcp` (**M**); depends on `fn-99-resident-local-context-gateway.2`
4. `fn-99-resident-local-context-gateway.4` — Unify health and prove concurrent lifecycle correctness (**M**); depends on `fn-99-resident-local-context-gateway.1`, `fn-99-resident-local-context-gateway.2`, `fn-99-resident-local-context-gateway.3`
5. `fn-99-resident-local-context-gateway.5` — Prove packaged cross-platform behavior and ship docs (**M**); depends on `fn-99-resident-local-context-gateway.4`

Landing groups: task 1 foundation; tasks 2+3 as one inseparable transport-security release unit; task 4 health/concurrency; task 5 packaging/docs. Never expose `/mcp` publicly between tasks 2 and 3.

## Quick commands

```bash
bun test test/mcp test/serve test/store
bun run smoke:serve-shutdown
bun run test:package
bun run lint:check
.flow/bin/flowctl validate --spec fn-99-resident-local-context-gateway --json
```

## References

- MCP 2025-11-25 Streamable HTTP transport and security requirements.
- `@modelcontextprotocol/sdk` 1.29 `WebStandardStreamableHTTPServerTransport`.
- Bun `Bun.serve`, `requestIP`, `maxRequestBodySize`, and `idleTimeout` APIs.
- `src/serve/background-runtime.ts`, `src/mcp/server.ts`, `src/core/job-manager.ts`, `src/serve/jobs.ts`, `src/store/sqlite/adapter.ts`, and `src/llm/nodeLlamaCpp/lifecycle.ts`.

## Early proof point

Task 1 must prove that one resident owner can host the existing Web/REST runtime and a shared pure MCP surface without global model disposal, stale captured config, duplicated jobs, or async SQLite transaction ownership. If that boundary fails, stop before implementing the network transport.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
| -- | -- | -- | -- |
| R1 | Two isolated clients share one resident process/runtime. | .1, .2, .4 | — |
| R2 | Warm model reuse and lease-safe cleanup. | .1, .4 | — |
| R3 | Stdio/HTTP contract parity. | .1, .2 | — |
| R4 | Concurrency, cancellation, restart, shutdown, integrity. | .1, .2, .4, .5 | — |
| R5 | Fail-closed loopback/non-loopback security. | .3, .5 | — |
| R6 | One truthful resident lifecycle across product surfaces. | .1, .4, .5 | — |
| R7 | Packaged and hosted cross-platform proof. | .5 | — |
