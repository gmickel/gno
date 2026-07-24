---
satisfies: [R1, R3, R4, R5, R6]
---
# fn-106-browser-clipper-with-provenance.4 Package test and document the local clipper

## Description
Deliver package test and document the local clipper as one implementation-sized increment.

**Size:** M
**Files:** `browser-extension`, `test/clipper/e2e.test.ts`, `docs/integrations/browser-clipper.md`, `docs/API.md`, `docs/INSTALLATION.md`, `assets/skill/recipes/capture-and-file.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Add headed browser E2E for the exact task 2 routes: extension-origin `POST /api/clipper/pair/start`; loopback Web UI `GET /api/clipper/pair/csrf` and CSRF-bound `POST /api/clipper/pair/approve`; one-time same-extension-origin `GET /api/clipper/pair/:pairId`; bearer preview/write/revoke. Cover closed selection/Reader payloads, edit/re-preview, digest-bound write, provenance-bearing capture receipt, collision outcomes, and malicious local-origin attempts.
- Run against the loopback `gno serve` gateway and prove structural absence with `clipperRoutesForBind(false, gateway)`, not only runtime rejection. Assert the redacted `resident-status@1.0` `GET /api/resident/status` surface for offline/readiness reporting; never use it to recover credentials or authorize capture.
- Add contract/E2E coverage for task 1's shared runtime/Draft-07 rules: payload version and 512 KiB ceiling; absolute HTTP(S) URL subset; recursive C0/C1 rejection with TAB/LF/CR preservation; closed Reader AST; edited-Markdown denial of raw HTML/images/reference links; deterministic canonical Markdown, hashes, warning codes, and receipt provenance.
- Prove preview and duplicate semantics end to end: preview digest changes for edits/source metadata/destination/tags/extraction but not a later server clock; exact selection remains in provenance; matching stored `clipIdentity` opens existing, absent/different provenance or the same extraction with a changed final body conflicts, and suffix policy reports `created_with_suffix`.
- Prove pairing and client-state boundaries: exact Chromium extension Origin on every extension request; exact Host/actual loopback peer; no wildcard/credentials CORS; PNA preflight allowlists; same-origin `X-GNO-CSRF` approval; one-time token poll; local-only token storage; expiry/revoke/restart behavior; no MCP/API bearer cross-use.
- Prove write recovery: raw payload preview, exact `{payload, previewDigest}` write body, 1–256 visible-ASCII `Idempotency-Key`, retry with the same logical state, stored `Idempotent-Replay`, pending recovery after a simulated write-before-receipt crash, and fail-closed file/plan drift with `CLIPPER_IDEMPOTENCY_RECOVERY_CONFLICT` and no suffix/path change.
- Validate every response against its task 2 Draft-07 schema and exercise the closed `clipper-error@1.0` vocabulary. Reuse `createClipperRouteGateway`/`clipperRoutesForBind`, `ClipperSecurityBoundary`/`ClipperRequestGate`/`readClipperBoundedJson`, `clipperSha256`, `createClipperGrant`, `planResidentCapture`/`browserClipIdempotencyPlan`, and `loadSchema`/`assertValid` rather than duplicating gateway internals in fixtures.
- Define reproducible extension build/package/version/privacy disclosure and manual distribution/update channel; do not claim store publication until completed.
- Update API/Web/config/troubleshooting/skill/hosted docs with the exact route table, split-origin pairing/CSRF/token-storage flow, `BrowserClipPayload`/`browser-clip-preview@1.0`/capture-receipt boundary, idempotency/restart recovery, error vocabulary, warning and collision-result vocabularies, structural loopback-only security, and no-history/no-OAuth boundaries.

### Investigation targets
**Required** (read before coding):
- `scripts/web-ui-smoke.ts`
- `src/core/browser-clip.ts`
- `src/core/browser-clip-provenance.ts`
- `src/core/capture.ts`
- `src/serve/routes/clipper.ts`
- `src/serve/clipper-contract.ts`
- `src/serve/clipper-security.ts`
- `src/serve/clipper-capture.ts`
- `src/serve/capture-service.ts`
- `src/store/sqlite/clipper-store.ts`
- `spec/output-schemas/capture-receipt.schema.json`
- `spec/output-schemas/mcp-capture-result.schema.json`
- `spec/output-schemas/browser-clip-preview.schema.json`
- `spec/output-schemas/clipper-csrf.schema.json`
- `spec/output-schemas/clipper-error.schema.json`
- `spec/output-schemas/clipper-pair-approval.schema.json`
- `spec/output-schemas/clipper-pair-start.schema.json`
- `spec/output-schemas/clipper-pair-status.schema.json`
- `spec/output-schemas/clipper-revoke.schema.json`
- `test/clipper/pairing-security.test.ts`
- `test/clipper/routes.test.ts`
- `test/clipper/recovery.test.ts`
- `test/spec/schemas/validator.ts`
- `docs/API.md`
- `docs/INSTALLATION.md`
- `assets/skill/recipes/capture-and-file.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

**Optional** (reference as needed):
- `docs/MCP.md`
## Acceptance
- [ ] Browser E2E proves the exact start → same-origin CSRF approval → one-time origin-bound poll → bearer preview/write/revoke flow and all security denials, including that bearer gateway authentication and `gateway.enableWrite` do not substitute for a scoped clipper token. <!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.5 finalized separate gateway identity and write authorization -->
- [ ] Tests prove actual-peer/Host/Origin/CORS/PNA/body/rate/concurrency enforcement and `clipperRoutesForBind(false, gateway) === {}`; no public/non-loopback clipper surface exists.
- [ ] Contract/E2E tests preserve runtime/Draft-07 parity for the closed URL/control/size/payload rules and reject unsupported Reader/Markdown inputs without remote fetching or silent coercion.
- [ ] E2E proves exact-selection provenance, server-owned preview-digest drift rules, provenance-bearing receipts, and `opened_existing`/`conflict`/`created_with_suffix` behavior, including changed final edits.
- [ ] Restart/crash E2E proves completed receipt replay and exact-path pending recovery, while missing previews and plan/file drift produce the documented closed errors without duplicate writes or changed destinations.
- [ ] All task 2 success/error responses validate against their named version `1.0` schemas, and the extension gives deterministic recovery for each pairing, authorization, preview, idempotency, transport, validation, and runtime class.
- [ ] Extension package is reproducible, versioned, minimally permissioned, and carries an accurate privacy disclosure.
- [ ] Repo/skill/gno.sh documentation names the exact routes, pairing/CSRF/origin/token-storage lifecycle, versioned payload and response schemas, Reader AST/edited-Markdown boundary, server preview/provenance ownership, idempotency recovery/errors, warning codes, collision results, and structural loopback-only privacy/security limits.
- [ ] Full lint/tests/docs/package checks pass.

<!-- Updated by plan-sync: fn-106.1 finalized the validation, preview/provenance, receipt-schema, and duplicate contracts that final E2E/docs must prove. -->
<!-- Updated by plan-sync: fn-106.2 finalized route/security/storage/schema/idempotency contracts and reusable gateway test surfaces. -->

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
