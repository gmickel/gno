---
satisfies: [R1, R5, R6]
---
# fn-106-browser-clipper-with-provenance.3 Build the minimal browser extension preview workflow

## Description
Deliver build the minimal browser extension preview workflow as one implementation-sized increment.

**Size:** M
**Files:** `browser-extension/manifest.json`, `browser-extension/src/service-worker.ts`, `browser-extension/src/content.ts`, `browser-extension/src/gateway.ts`, `browser-extension/src/storage.ts`, `browser-extension/src/preview.tsx`, `browser-extension/test`, `src/serve/public`

### Approach
- Target Chromium Manifest V3 first with `activeTab`, `scripting`, and loopback host permissions only; document Firefox as a follow-up unless parity is explicitly validated.
- Implement the exact task 2 pairing sequence. From the extension origin, `POST /api/clipper/pair/start` with no body; retain the returned 64-hex `pairId`, eight-digit `pairingCode`, five-minute `expiresAt`, exact extension `origin`, and `approvalPath`. Open the loopback Web UI for visible approval. The same-origin page first `GET /api/clipper/pair/csrf`, then `POST /api/clipper/pair/approve` with `X-GNO-CSRF` and the closed `{pairId, pairingCode}` body. Poll `GET /api/clipper/pair/:pairId` from the same extension origin until `approved` or a terminal status; consume `grantId`, 64-hex `grantToken`, and `expiresAt` only from that one successful poll.
- Keep the pairing ID/code transient and clear them on approval, expiry, failure, or cancellation. Persist only the selected exact loopback gateway origin and approved `{grantId, grantToken, expiresAt}` in `chrome.storage.local` so an MV3 service-worker restart does not lose the grant; never sync it, expose it to content scripts/page DOM, or send it to another origin. Validate the start response's `origin` against `chrome-extension://${chrome.runtime.id}` before accepting it.
- On explicit action, emit the closed `BrowserClipPayload` version `1.0`: selection mode keeps `selection.exactText` separate from nullable `selection.editedMarkdown`; Reader mode emits only the supported paragraph/heading/quote/list/code/horizontal-rule AST with text/link inline nodes and nullable `reader.editedMarkdown`. Never submit raw HTML, images, reference links, or an extension-defined provenance object.
- Send source/canonical URLs and all free-form strings through the server contract. Treat task 1's absolute HTTP(S) URL subset, 512 KiB limit, and C0/C1 control rejection as authoritative; display closed validation failures instead of loosening or independently normalizing them.
- Call `POST /api/capture/clip/preview` with the raw `BrowserClipPayload` and `Authorization: Bearer <grantToken>`. Render the closed `browser-clip-preview@1.0` response: `preview.body/digest/source/destination/tags`, full `provenance`, and `plan.collection/relPath/outcome/provenanceConflict`. Keep exact selection available for provenance while allowing an edited final body; do not compute hashes, clip identity, normalized URLs, canonical Reader Markdown, or preview digest in the extension.
- Let the user edit content/frontmatter/destination/tags and request a fresh server preview after each meaningful change. Commit with `POST /api/capture/clip`, the closed `{payload, previewDigest}` body, bearer grant, and a visible-ASCII `Idempotency-Key` of 1–256 characters.
- Persist the latest confirmed payload, preview digest, and idempotency key as one pending logical write until a terminal shared `capture-receipt@1.0` or non-retryable error. Reuse them across service-worker/network retries. Honor `Idempotent-Replay: true`; on `CLIPPER_IDEMPOTENCY_PENDING`, retry with backoff; on preview-required/mismatch after a server restart or edit, obtain a fresh preview; never silently choose a new destination after `CLIPPER_IDEMPOTENCY_RECOVERY_CONFLICT`.
- Revoke with bearer-authenticated `POST /api/clipper/revoke` and clear local grant/pending state after the closed revoke response. Also clear unusable grant state on expiry or `CLIPPER_UNAUTHORIZED`.
- Parse every non-receipt failure as `clipper-error@1.0`. Give explicit recovery for pairing terminal states and CSRF errors, authorization/expiry, preview-required/mismatch, pending/conflicting/recovery-conflicting idempotency, validation/body limits, gateway busy/rate limits, offline gateway, and capture/runtime failures. Expose provenance warnings and collision outcomes `opened_existing`, `conflict`, and `created_with_suffix` without relabeling server results.

### Investigation targets
**Required** (read before coding):
- `src/core/browser-clip.ts`
- `src/core/browser-clip-provenance.ts`
- `src/core/capture.ts`
- `src/serve/routes/clipper.ts`
- `src/serve/clipper-contract.ts`
- `src/serve/clipper-pairing.ts`
- `src/serve/clipper-capture.ts`
- `spec/output-schemas/browser-clip-preview.schema.json`
- `spec/output-schemas/clipper-error.schema.json`
- `spec/output-schemas/clipper-pair-start.schema.json`
- `spec/output-schemas/clipper-pair-status.schema.json`
- `spec/output-schemas/clipper-pair-approval.schema.json`
- `spec/output-schemas/clipper-csrf.schema.json`
- `spec/output-schemas/clipper-revoke.schema.json`
- `spec/output-schemas/capture-receipt.schema.json`

**Optional** (reference as needed):
- `src/serve/public/components/CaptureModal.tsx`
- `src/serve/public/components/TagInput.tsx`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `createClipperRouteGateway` / `clipperRoutesForBind`
- task 2's closed clipper response/error schemas

### Key context
- Never read history, cookies, sessions, background tabs, or bypass paywalls; only user-visible content selected on explicit action.
- Task 1 owns canonical Markdown, hashes, normalized provenance, warning vocabulary, and duplicate identity. The extension owns extraction inputs and UI state only.
- Task 2 routes exist only on the loopback `gno serve` listener. Do not add arbitrary/non-loopback gateway configuration or treat MCP/API credentials, `gateway.enableWrite`, cookies, or the approval CSRF token as clipper authorization.
- Approval is deliberately split across origins: extension-origin start/poll; exact loopback Web UI CSRF/approve. The bearer grant is returned once to the exact extension origin and is bound to that origin for every preview/write/revoke request.
- Server preview tickets are in-memory and short-lived; grants and bounded idempotency receipts survive restart. A completed request can replay after restart, while a never-claimed write must refresh a lost preview.
- `clipper-error@1.0` is closed to `CLIPPER_ABORTED`, `CLIPPER_BODY_TOO_LARGE`, `CLIPPER_BUSY`, `CLIPPER_FORBIDDEN`, `CLIPPER_INVALID_JSON`, `CLIPPER_RATE_LIMITED`, `CLIPPER_UNAUTHORIZED`, `CLIPPER_PAIRING_UNAVAILABLE`, `CLIPPER_CSRF`, `CLIPPER_INVALID_REQUEST`, `CLIPPER_PAIR_NOT_FOUND`, `CLIPPER_PAIR_EXPIRED`, `CLIPPER_PAIR_INVALID_CODE`, `CLIPPER_PAIR_ALREADY_USED`, `CLIPPER_PREVIEW_MISMATCH`, `CLIPPER_PREVIEW_REQUIRED`, `CLIPPER_IDEMPOTENCY_PENDING`, `CLIPPER_IDEMPOTENCY_CONFLICT`, `CLIPPER_IDEMPOTENCY_RECOVERY_CONFLICT`, `CLIPPER_IDEMPOTENCY_GRANT_INACTIVE`, `CLIPPER_CAPTURE_FAILED`, `NOT_FOUND`, `RUNTIME`, and `VALIDATION`.

## Acceptance
- [ ] User can start pairing from the extension, visibly approve the exact eight-digit code in the loopback Web UI through `/api/clipper/pair/csrf` plus `X-GNO-CSRF`, receive the grant through one successful same-origin-bound poll, revoke it, and recover cleanly from pending/consumed/expired/not-found/origin-mismatch states.
- [ ] Pairing secrets and grant storage follow the boundary: transient pair ID/code; local-only exact gateway origin and approved grant; no sync/content-script/DOM exposure; mismatched extension origins are rejected before storage.
- [ ] User can select or Reader-capture, preview/edit, choose destination/tags, refresh the server preview, confirm once with the exact `{payload, previewDigest}` body plus bearer and `Idempotency-Key`, and see the canonical receipt.
- [ ] Selection and Reader fixtures emit only the closed version `1.0` payload: exact selection remains separate from edited Markdown, Reader output uses the supported AST, and raw HTML/images/reference links never cross the boundary.
- [ ] Preview UI validates/displays the closed `browser-clip-preview@1.0` server response and tests prove it does not locally derive hashes, normalized URLs, canonical Markdown, clip identity, or preview digest.
- [ ] A changed edit, metadata field, destination, tag, or extraction input requires a refreshed digest before write. Duplicate UI distinguishes an identical `opened_existing` receipt from provenance `conflict` and user-selected `created_with_suffix`.
- [ ] MV3 restart/network retry tests preserve one pending logical write and its idempotency key, accept stored receipt replay, refresh a lost/unclaimed preview, back off on pending, and stop for key/recovery conflicts without changing the saved destination.
- [ ] Every closed pairing/CSRF/revoke/preview/capture/error schema has client fixtures; unknown schema versions/codes fail closed instead of becoming success.
- [ ] Manifest permissions are minimal and no browsing-history/cookie/background-surveillance access exists.
- [ ] SPA, iframe, authenticated-visible, huge, Unicode/control-character, invalid-URL, duplicate, offline, expiry, and revoked-token fixtures are actionable.

<!-- Updated by plan-sync: fn-106.1 fixed the versioned payload/Reader AST, preview/provenance ownership, warnings, and duplicate identity semantics consumed by the extension. -->
<!-- Updated by plan-sync: fn-106.2 finalized the split-origin pairing/CSRF flow, one-time origin-bound grant, closed route schemas, and restart-safe idempotency/recovery contract. -->

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
