---
satisfies: [R3, R5]
---
# fn-106-browser-clipper-with-provenance.2 Add secure loopback clipper pairing and capture endpoints

## Description
Add the visible pairing/grant lifecycle plus non-mutating preview and idempotent clip-write endpoints on the resident loopback gateway.

**Size:** L
**Files:** `src/serve/clipper-pairing.ts`, `src/serve/routes/clipper.ts`, `src/serve/security.ts`, `src/serve/server.ts`, `src/serve/routes/api.ts`, `src/serve/routes/mcp.ts`, `src/mcp/http-security.ts`, `src/store/migrations`, `spec/output-schemas`, `test/clipper/pairing-security.test.ts`, `test/clipper/capture-api.test.ts`

### Approach
- Implement device-flow-like pairing: `POST /api/clipper/pair/start`, same-origin Web UI `POST /api/clipper/pair/approve`, one-time `GET /api/clipper/pair/:id` delivery/poll, and authenticated `POST /api/clipper/revoke`.
- Pairing codes are in-memory, single-use, and expire within minutes. Persist only hashed, exact-extension-origin-bound, clipper-scoped grants with bounded expiry and revocation; restart revokes unfinished pairing codes but retains valid hashed grants.
- Same-origin approval is visible and CSRF-protected. GET never mutates approval state.
- Require actual loopback peer, exact Host, exact bound `chrome-extension://<id>` Origin, explicit OPTIONS/CORS/Private-Network-Access policy, body/rate/concurrency limits, expiry, revocation, and pairing-code replay defense.
- Keep gateway bearer identity and `gateway.enableWrite` separate: neither authorizes clipping, and a clipper grant never authorizes MCP or general REST.
- Add `POST /api/capture/clip/preview` as a non-mutating plan and `POST /api/capture/clip` as an idempotent write. Parse the closed `BrowserClipPayload` with `browserClipPayloadSchema`, then use `prepareBrowserClip`; do not recreate URL, control-character, Markdown, rendering, hash, or provenance rules in the route.
- Return the server-owned `PreparedBrowserClip.preview` digest/body/source/destination/tags plus provenance and capture-plan outcome. Require that digest plus a request/idempotency key on write, re-run `prepareBrowserClip` and capture planning, and reject any payload or destination drift before mutation.
- Load stored `source.browserClip.clipIdentity` values for candidate paths into `planCapture({ existingProvenanceByRelPath })`. `open_existing` succeeds only for the same stored identity; missing/different provenance, including the same extraction with a different final edit, returns `conflict`; `create_with_suffix` creates a distinct path and reports `created_with_suffix`.
- Extract shared capture plan/write/sync logic instead of internally fabricating HTTP requests. Return existing capture/sync/embed receipt semantics plus browser provenance warnings.
- Never fetch source/canonical URLs or images. Structurally omit clipper routes on non-loopback binding.

### Investigation targets
**Required** (read before coding):
- `src/serve/server.ts:200-330`
- `src/serve/security.ts`
- `src/serve/routes/mcp.ts`
- `src/mcp/http-security.ts`
- `src/serve/routes/api.ts:2869-3020`
- `src/core/capture-write.ts`
- `src/core/browser-clip.ts` (`browserClipPayloadSchema`, `prepareBrowserClip`, `PreparedBrowserClip`)
- `src/core/browser-clip-provenance.ts` (shared URL/control/warning/provenance contract)
- `src/core/capture.ts` (`existingProvenanceByRelPath`, `provenanceConflict`, `collisionPolicyResult`)
- `spec/output-schemas/capture-receipt.schema.json`
- `spec/output-schemas/mcp-capture-result.schema.json`

**Optional** (reference as needed):
- `src/app/constants.ts`
- `src/serve/resident-admission.ts`
- `src/store/migrations`

### Key context
- `GET /api/resident/status` is availability-only and never yields identity, credentials, process paths, or attachment authorization.
- Clipper grants belong beside the resident gateway auth boundary but remain a distinct least-privilege identity system.
- Task 1 fixed the payload/provenance schema at version `1.0`, a 512 KiB payload ceiling, an absolute HTTP(S) browser URL subset, and recursive C0/C1 control rejection while preserving TAB/LF/CR. Route validation must consume those shared exports so runtime and Draft-07 behavior cannot drift.
- `previewDigest` covers the final body, source metadata, destination, tags, and extraction data while excluding server capture time. It is stable across a later server clock but must change for meaningful preview edits.

## Acceptance
- [ ] Visible start/approve/one-time-delivery/revoke flows have stable closed receipts/errors; pairing code expiry/replay and grant expiry/revocation/restart semantics are explicit.
- [ ] Preview parses/prepares the exact task 1 payload without mutation and returns the server-owned preview/provenance/plan; write reparses/reprepares/replans and requires a matching preview digest plus idempotency key, so service-worker retries cannot double-write.
- [ ] Preview-drift tests cover final-body edits, source metadata, destination, tags, and extraction data; a later server clock alone does not invalidate the digest.
- [ ] Duplicate tests prove `opened_existing` only for matching stored `clipIdentity`, `conflict` for absent/different provenance or a changed final edit, and `created_with_suffix` for the suffix policy; receipts preserve browser provenance and the exact collision result.
- [ ] Actual-peer/Host/Origin/CSRF/OPTIONS/CORS/PNA/rate/body/concurrency tests block DNS rebinding, hostile Web origins, absent Origin, malformed extension origins, and oversized requests.
- [ ] MCP bearer and clipper grant cross-use is denied; `gateway.enableWrite` never substitutes for clipper authorization.
- [ ] No clipper endpoint mounts on a non-loopback listener and no route fetches remote content or images.
- [ ] Shared-schema tests cover the 512 KiB ceiling, the HTTP(S) URL subset, recursive control rejection with TAB/LF/CR preservation, edited-Markdown restrictions, and Reader AST closure; no route-local validator broadens the contract.
- [ ] Offline, duplicate, huge, expiry, revoked, preview-drift, and Unicode paths return actionable deterministic results without silent data loss.

<!-- Updated by plan-sync: fn-106.1 finalized browserClipPayloadSchema/prepareBrowserClip, server-owned previewDigest, and provenance-aware planCapture contracts. -->

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
