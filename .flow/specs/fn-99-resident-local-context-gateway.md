# fn-99 Resident Local Context Gateway

## Goal & Context
<!-- scope: business -->

Give every local client one always-warm GNO context service. Repeated stdio launches should not reload models or open independent store/job lifecycles. Extend the existing resident runtime with Streamable HTTP MCP so Web, REST, MCP clients, watchers, and models share one observable process.

## Architecture & Data Models
<!-- scope: technical -->

Refactor the current serve/daemon runtime into a single resident core owning store adapters, write lock, watcher, job manager, model manager, caches, and graceful shutdown. Mount the existing REST/Web routes and a standards-compliant Streamable HTTP MCP endpoint at `/mcp`; do not introduce a third daemon.

Use the official MCP SDK transport with session lifecycle, bounded connection/request queues, cancellation, and shared read/write coordination. Stdio MCP remains supported and may connect directly as today; CLI commands remain direct initially. Health reports active clients, warm models, queue depth, index generation, and degraded capabilities without exposing secrets.

## API Contracts
<!-- scope: technical -->

- `gno serve`/`gno daemon` expose `/mcp` when enabled; loopback binding is the default.
- Streamable HTTP supports initialize, tool/resource operations, resumable/session semantics required by the SDK, and clean client disconnect.
- MCP tool/resource schemas remain identical across stdio and HTTP transports.
- Non-loopback bind requires an explicit token/config opt-in; bearer auth and allowed Origins/Hosts are enforced before MCP dispatch.
- Additive health/status fields describe resident lifecycle and transport state.

## Edge Cases & Constraints
<!-- scope: technical -->

- Defend against DNS rebinding with Host and Origin validation even on localhost.
- No unauthenticated non-loopback exposure; wildcard bind without token is a startup error.
- Concurrent reads and indexing obey the existing locking contract and remain responsive.
- Multiple clients share models but cannot leak request/session state to one another.
- Cancellation/disconnect releases resources; bounded queues reject overload explicitly.
- SIGINT/SIGTERM, restart, model failure, and stale session cleanup preserve DB correctness.
- Windows/macOS/Linux lifecycle and packaged desktop paths require coverage.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Two independent MCP clients simultaneously use one resident process/store/model lifecycle through `/mcp`.
- **R2:** Repeated calls do not reload an already warm embedding/rerank/generation model; lifecycle metrics/tests prove reuse.
- **R3:** Stdio and HTTP MCP return contract-equivalent tool/resource results from the same fixtures.
- **R4:** Concurrent reads, writes/indexing, cancellation, disconnect, restart, and shutdown pass integration tests without corruption or deadlock.
- **R5:** Loopback is safe by default; Host/Origin checks block rebinding; non-loopback requires explicit token auth.
- **R6:** CLI/Web/Desktop health and docs expose one resident core rather than competing server/daemon states.
- **R7:** Packaged npm and desktop smoke tests cover the transport on supported operating systems.

## Boundaries
<!-- scope: business -->

No remote OAuth, team tenancy, cloud relay, multi-user authorization, CLI client/server conversion, or second resident daemon.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Operational simplicity is qmd's clearest advantage. A warm shared gateway improves latency and reliability while making GNO's broader capabilities easier for multiple agent clients to consume.

### Implementation Tradeoffs
<!-- scope: technical -->

Extending the existing runtime avoids duplicated locks/models/jobs. Streamable HTTP is the MCP-recommended resident transport, but strict loopback and rebinding controls are mandatory because localhost is still a network boundary.
