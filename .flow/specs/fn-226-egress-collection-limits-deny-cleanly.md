# Egress collection limits deny cleanly instead of failing

## Conversation Evidence

> user (turn 2): "plus the clean parts of the mixed ones (#315 ls --filter; #318 the 500-to-403 fix)"
> user (turn 2): "reference the original PR(s) and say it supersedes them"
> user (turn 2): "leave out ... the ... derived_from convention, permission-boundary framing, the raised egress caps"
> user (turn 3): "Just say the spec supersedes the referenced PR(s) and uses them as reference for the intended outcome."

## Goal & Context
<!-- scope: business -->

<!-- Source: 10% user / 30% [paraphrase] / 60% [inferred] -->

This spec supersedes the 500-to-403 fix in #318 and uses it as reference for the intended outcome. The cap increases #318 also makes are not part of this spec. Its CHANGELOG entry credits @ArnauvGilotra for the idea and the original pull request.

Collection egress evaluation has two bounds: 64 collections for a policy decision and 128 for egress lineage. They were never reconciled. Over HTTP MCP:
- Between 65 and 128 configured collections, an unscoped call gets the documented policy denial `COLLECTION_LIMIT_EXCEEDED`.
- Above 128 configured collections, the lineage builder rejects the whole configured set before the request's scope is considered. The transport then turns that into `500 Internal MCP transport error` for every call, scoped or not.

Other surfaces that evaluate egress over the configured set have the same failure class. This spec makes every over-bound case a deterministic policy outcome. No bound is raised.

## Architecture & Data Models
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

- Egress evaluation works on the request's scope. For a scoped call, that is the named collections. For an unscoped call, it is every configured collection.
- Bounds are checked against that scope, not against the full configuration. A scoped call naming a few collections is evaluated normally however many collections are configured.
- An unscoped call over the bound becomes the existing `COLLECTION_LIMIT_EXCEEDED` decision.
- Exceeding a bound is a policy denial, never an internal error, on every surface that evaluates egress: HTTP MCP tool calls, sync and update tools reached over MCP, daemon status, the browser-clipper route and compiled-context exports. Each surface reports the denial through its existing denial path. The HTTP MCP surface uses its existing redacted denial response.
- The bounds stay as they are: 64 per decision, 128 lineage sources, 64 names for an explicit `gno_egress_check` scope.

## API Contracts
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

| Configured collections | Scoped call (≤ 64 named) | Unscoped call |
|---|---|---|
| 1 to 64 | evaluated (unchanged) | evaluated (unchanged) |
| 65 to 128 | evaluated (unchanged) | 403 `COLLECTION_LIMIT_EXCEEDED` (unchanged) |
| above 128 | evaluated (was 500) | 403 `COLLECTION_LIMIT_EXCEEDED` (was 500) |

A scoped call naming more than 64 collections gets 403 `COLLECTION_LIMIT_EXCEEDED` at any configuration size. The denial body names no collections, as today.

## Edge Cases & Constraints
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

- Every way of exceeding a bound fails closed. No over-bound path may serve data or skip the egress check.
- Other errors from lineage building (malformed scope, invalid policy) keep their current handling. Only the bound becomes a policy denial.
- Output schemas are unchanged.
- Docs: the bounds and `COLLECTION_LIMIT_EXCEEDED` are documented today only as a schema enum. `docs/CONFIGURATION.md` and `spec/mcp.md` state the bounds and the denial. CHANGELOG `Fixed`.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** With 129 or more collections configured, an HTTP MCP call scoped to one collection is evaluated and served under that collection's policy. An unscoped call gets 403 `COLLECTION_LIMIT_EXCEEDED`. Neither returns a 500. [paraphrase] Errors: as stated.
- **R2:** Behaviour at 1 to 128 configured collections is unchanged, including the existing 403 for unscoped calls between 65 and 128. Tests pin 64, 65, 128 and 129. [inferred] Errors: none beyond R1.
- **R3:** Daemon status, MCP sync and update tools, the clipper route and compiled-context exports return their existing egress denial, not an internal error, when the scope they evaluate exceeds a bound. [inferred] Errors: as stated.
- **R4:** No bound changes. The decision bound stays 64, lineage 128 and the explicit `gno_egress_check` scope 64, and output schemas are unchanged. [paraphrase] Errors: none.
- **R5:** `docs/CONFIGURATION.md` and `spec/mcp.md` document the bounds and the `COLLECTION_LIMIT_EXCEEDED` denial. [inferred] Errors: none.

## Boundaries
<!-- scope: business -->

- No raised or configurable bounds. [paraphrase]
- No change to how policy levels decide (`local_only` and wider). [inferred]

## Decision Context
<!-- scope: both — conditionally substructured -->

The intended outcome follows #318's fix: an over-bound configuration is a policy denial, not a 500. These changes from #318 are deliberate: [inferred]

- **Bounds kept.** #318 raised every bound to 1024 for deployments with hundreds of collections. The bounds exist to cap egress audit work and the size of persisted lineage. Whether to raise them is recorded with the multi-user gateway decisions (fn-227, D5), where it needs latency and receipt-size evidence.
- **Scoped calls judged on their scope.** Under #318 with the old bounds, a call naming one collection is still refused once more than 128 are configured. Scoped calls already work between 65 and 128, and judging them on their own scope above 128 keeps that consistent without raising anything.
- **All surfaces, not only HTTP MCP.** The same unhandled bound error reaches daemon status, sync egress and the clipper. Fixing one surface would leave the same failure class on the others.

## Strategy Alignment

- Controlled portability: explicit, deterministic egress outcomes with no opaque failures at the network boundary. [strategy:Controlled portability]
- Coherent agent and application surfaces: one denial contract on every surface that evaluates egress. [strategy:Coherent agent and application surfaces]
