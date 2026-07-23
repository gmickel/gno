# fn-111 Collection Egress Policies

## Goal & Context
<!-- scope: business -->

Give users a fail-closed, collection-level boundary for where content may travel. Before broader remote inference, LAN access, or private remote agent access, every operation must answer whether a collection is `local_only`, `lan`, or `remote` and explain the decision.

## Architecture & Data Models
<!-- scope: technical -->

Add a required effective `egressPolicy` to collection configuration with values:

- `local_only`: local process/loopback clients and local models only; no network publication or remote inference.
- `lan`: authenticated private-network serving allowed; no public internet/cloud inference/publication.
- `remote`: explicitly permits remote transport subject to operation-specific auth, visibility, and provider controls.

Centralize evaluation in an `EgressPolicyPort` receiving collection(s), action (`retrieve`, `serve`, `publish`, `remote_inference`, `export`, `clip_write`), destination zone/host/provider, caller/auth context, and content class. It returns an allow/deny decision with reason codes and redacted audit metadata. All network-capable adapters and mixed-collection operations call this port before content leaves the process.

Migration is explicit and fail-closed: new collections default `local_only`; existing collections receive a documented local-only effective default until the user selects otherwise. Explicit one-shot export to a local file remains local; public publish/remote provider use requires policy change or a narrowly scoped, visible one-shot confirmation recorded in the receipt.

## API Contracts
<!-- scope: technical -->

- Config/collection add/edit surfaces expose `egressPolicy`; schemas and status show effective policy/source.
- CLI: collection policy get/set/check plus `--explain-egress` on affected commands.
- REST/MCP/SDK errors use stable `EGRESS_DENIED` codes with collection/action/destination/reason, never content.
- Resident gateway non-loopback serving intersects transport auth with every referenced collection policy; auth alone never overrides policy.
- Audit receipts are local, bounded, redacted, and inspectable/purgeable.

## Edge Cases & Constraints
<!-- scope: technical -->

- Mixed-collection queries use the most restrictive participating policy for outgoing content; denied collections are not silently omitted unless the caller explicitly requests partial results and receives disclosure.
- Loopback, LAN, VPN/Tailscale, public IP, proxy headers, DNS rebinding, redirects, and provider endpoints need conservative destination classification.
- Derived data—snippets, embeddings, Capsules, logs, traces, metadata, attachments—retains source policy; transformation is not declassification.
- Publicly published reader projections are governed at publish time and cannot grant access back to the local collection.
- Policy/config changes invalidate resident sessions/caches where necessary.
- No secret/token may appear in explain or audit output.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Every collection has a deterministic effective `local_only|lan|remote` policy and new/existing migration defaults fail closed.
- **R2:** A single shared evaluator gates non-loopback serving, public/private publishing, remote inference, network export, and any future remote agent path before content transfer.
- **R3:** Mixed-collection and derived-artifact operations preserve the most restrictive source policy with explicit partial/deny semantics.
- **R4:** LAN/public/loopback/VPN/proxy/rebinding/redirect classification and auth-policy intersection pass adversarial integration tests.
- **R5:** CLI, REST, MCP, SDK, Web/Desktop config, schemas, docs, and status/explain surfaces share stable allow/deny reason codes.
- **R6:** Local bounded audit receipts support inspect/purge and never contain content, credentials, or sensitive absolute paths.
- **R7:** Remote/private features remain disabled until their own authentication controls and this policy gate both pass; encrypted spaces are never server-decrypted.
- **R8:** Existing local retrieval/indexing behavior remains usable after migration; blocked network actions provide explicit remediation.

## Boundaries
<!-- scope: business -->

No full identity/tenant system, OAuth provider framework, DRM, content classification engine, server-side decryption, legal compliance certification, or automatic relaxation based on network heuristics.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Local-first trust fails if new gateways, models, and publishing paths can move content without a clear collection-owned rule. Egress must be a product primitive before remote breadth.

### Implementation Tradeoffs
<!-- scope: technical -->

Fail-closed defaults create deliberate friction for network features but prevent surprising disclosure. One centralized evaluator is easier to audit than scattered booleans, while stable reason codes keep denials actionable across every surface.

## Implementation Plan

1. `fn-111-collection-egress-policies.1` — Define egress policy schema evaluator and fail-closed migration (**M**)
2. `fn-111-collection-egress-policies.2` — Build conservative destination and network-zone classification (**M**); depends on `fn-111-collection-egress-policies.1`
3. `fn-111-collection-egress-policies.3` — Enforce policy at every current network-capable boundary (**M**); depends on `fn-111-collection-egress-policies.1`, `fn-111-collection-egress-policies.2`
4. `fn-111-collection-egress-policies.4` — Propagate restrictive policy through mixed and derived data with audit (**M**); depends on `fn-111-collection-egress-policies.1`, `fn-111-collection-egress-policies.3`
5. `fn-111-collection-egress-policies.5` — Expose policy configuration checks and denials across surfaces (**M**); depends on `fn-111-collection-egress-policies.4`
6. `fn-111-collection-egress-policies.6` — Prove migration adversarial enforcement and public security docs (**M**); depends on `fn-111-collection-egress-policies.5`

## Quick commands

```bash
bun test test/egress test/publish test/mcp
bun run test:package
.flow/bin/flowctl validate --spec fn-111-collection-egress-policies --json
```

## References

- `src/config/types.ts:71-114` and `src/store/types.ts:67-130` — collection contracts.
- `src/publish/export-service.ts:347-390` — publish handoff.
- `src/mcp/http-security.ts` and fn-99 HTTP gateway security.
<!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.3 changed the HTTP gateway boundary module from src/serve/security.ts to src/mcp/http-security.ts -->
- [MCP transport security](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## Early proof point

Task `fn-111-collection-egress-policies.1` validates the core approach (one fail-closed evaluator returns stable allow/deny reasons for local, LAN, and remote actions before any transfer).
If it fails, re-evaluate policy ownership, destination classification, and derived-data inheritance before continuing with `fn-111-collection-egress-policies.2`+.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | Every collection has a deterministic effective `local_only\|lan\|remote` policy and new/existing migration defaults fail closed. | fn-111-collection-egress-policies.1, fn-111-collection-egress-policies.5, fn-111-collection-egress-policies.6 | — |
| R2 | A single shared evaluator gates non-loopback serving, public/private publishing, remote inference, network export, and any future remote agent path before content transfer. | fn-111-collection-egress-policies.1, fn-111-collection-egress-policies.2, fn-111-collection-egress-policies.3, fn-111-collection-egress-policies.6 | — |
| R3 | Mixed-collection and derived-artifact operations preserve the most restrictive source policy with explicit partial/deny semantics. | fn-111-collection-egress-policies.4, fn-111-collection-egress-policies.6 | — |
| R4 | LAN/public/loopback/VPN/proxy/rebinding/redirect classification and auth-policy intersection pass adversarial integration tests. | fn-111-collection-egress-policies.2, fn-111-collection-egress-policies.3, fn-111-collection-egress-policies.6 | — |
| R5 | CLI, REST, MCP, SDK, Web/Desktop config, schemas, docs, and status/explain surfaces share stable allow/deny reason codes. | fn-111-collection-egress-policies.5, fn-111-collection-egress-policies.6 | — |
| R6 | Local bounded audit receipts support inspect/purge and never contain content, credentials, or sensitive absolute paths. | fn-111-collection-egress-policies.4, fn-111-collection-egress-policies.5, fn-111-collection-egress-policies.6 | — |
| R7 | Remote/private features remain disabled until their own authentication controls and this policy gate both pass; encrypted spaces are never server-decrypted. | fn-111-collection-egress-policies.1, fn-111-collection-egress-policies.2, fn-111-collection-egress-policies.3, fn-111-collection-egress-policies.4, fn-111-collection-egress-policies.6 | — |
| R8 | Existing local retrieval/indexing behavior remains usable after migration; blocked network actions provide explicit remediation. | fn-111-collection-egress-policies.1, fn-111-collection-egress-policies.5, fn-111-collection-egress-policies.6 | — |
