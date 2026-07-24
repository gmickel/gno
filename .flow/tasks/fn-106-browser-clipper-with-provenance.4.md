---
satisfies: [R1, R3, R4, R5, R6]
---
# fn-106-browser-clipper-with-provenance.4 Package test and document the local clipper

## Description
Turn the completed Chromium MV3 clipper and deterministic unpacked build into a reproducible local artifact, prove the real extension/Web UI/gateway flow in headed Chromium, and finish truthful privacy, skill, repo, and hosted documentation.

**Size:** M
**Files:** `browser-extension`, `browser-extension/PRIVACY.md`, `test/clipper/e2e.test.ts`, `docs/integrations/browser-clipper.md`, `docs/API.md`, `docs/WEB-UI.md`, `docs/INSTALLATION.md`, `docs/PACKAGING.md`, `spec/cli.md`, `assets/skill/recipes/capture-and-file.md`, `package.json`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Build on task 3's existing `bun run build:clipper` output at `browser-extension/dist`; do not recreate the extension workflow. Define one manifest/artifact version source, a deterministic distributable archive and checksum, clean-build/package commands, and manual install/update instructions. Build/package twice from the same source and compare bytes. Do not claim Chrome Web Store or Firefox publication.
- Add headed Chromium E2E that loads the real unpacked `browser-extension/dist` into a persistent test profile and runs against an isolated loopback `gno serve` collection. Exercise the real popup, service worker, content script, `/clipper/pair#pairId=<64-hex-id>` Web approval page, and exact task 2 routes through selection and Reader captures.
- In that browser flow, prove the extension-origin `POST /api/clipper/pair/start`; fragment scrubbing before workspace state; loopback Web UI `GET /api/clipper/pair/csrf` and `X-GNO-CSRF` `POST /api/clipper/pair/approve`; one-time same-extension-origin `GET /api/clipper/pair/:pairId`; bearer preview/write/revoke; and that the approval page/content script never receive the grant.
- Run against the loopback `gno serve` gateway and prove structural absence with `clipperRoutesForBind(false, gateway)`, not only runtime rejection. Assert the redacted `resident-status@1.0` `GET /api/resident/status` surface for offline/readiness reporting; never use it to recover credentials or authorize capture.
- Use an adversarial fixture page to prove explicit user-triggered, active top-frame, visible-only extraction. Preserve an exact rendered selection or the constrained Reader AST while excluding hidden/inert/`aria-hidden`, non-rendered, script/style/form/nav/aside, iframe/embed/object, image/media/canvas, SVG, MathML, dangerous-link, and background-tab content. Verify `reader_partial`, `spa_snapshot`, and authenticated-visible disclosures without reading cookies, sessions, history, or raw HTML.
- Prove preview and duplicate semantics end to end: edits/source metadata/destination/tags/extraction invalidate the popup preview; exact selection remains in provenance; matching stored `clipIdentity` opens existing, absent/different provenance or the same extraction with a changed final body conflicts, and suffix policy reports `created_with_suffix`. Assert the finalized provenance fields `extractionHash`, `finalBodyHash`, `clipIdentity`, and `previewDigest`; never document or expect a browser-clip `sourceHash`.
- Prove pairing and client-state boundaries: exact Chromium extension Origin on every extension request; exact Host/actual loopback peer; no wildcard/credentials CORS; PNA preflight allowlists; same-origin `X-GNO-CSRF` approval; one-time token poll; local-only token storage; expiry/revoke/restart behavior; no MCP/API bearer cross-use.
- Prove popup/service-worker recovery with the shipped storage/controller behavior: transient pairing in `chrome.storage.session`; protected `chrome.storage.local` access restricted to trusted contexts; one saved `{payload, previewDigest, idempotencyKey}` logical write; popup `Retry saved write`/`Stop recovery`; single in-flight capture; same-key retry/backoff; same-payload preview refresh after lost server state; refusal of a different capture while pending; receipt replay; and fail-closed key/file/plan recovery conflicts without suffix/path changes.
- Validate exact wire closure. Browser-clipper receipts require `schemaVersion: "1.0"` and closed receipt/source/index-status objects. Parse a valid receipt before classifying status: HTTP 200 only for `opened_existing`, HTTP 202 for `created`, `created_with_suffix`, or `overwritten`, and HTTP 409 for a valid `conflict` receipt. Other failures must be closed `clipper-error@1.0` bodies with the documented code/status pairing; unknown fields, versions, codes, non-JSON bodies, and impossible status/body combinations fail as invalid responses.
- Reuse task 3's real client schemas and controller plus `createClipperRouteGateway`/`clipperRoutesForBind`, `ClipperSecurityBoundary`/`ClipperRequestGate`/`readClipperBoundedJson`, `clipperSha256`, `createClipperGrant`, `planResidentCapture`/`browserClipIdempotencyPlan`, and `loadSchema`/`assertValid` rather than duplicating gateway internals in fixtures.
- Publish an accurate privacy disclosure and update API/Web/config/troubleshooting/skill/hosted docs with the exact route table, visible-only extraction boundary, split-origin pairing/CSRF/token-storage flow, versioned closed receipt/status rules, recovery UX, client-only vs wire errors, warning/collision vocabulary, structural loopback-only security, and no-history/no-cookie/no-OAuth boundaries. Build and deploy the `gno.sh` docs change, then verify the live page; do not claim store availability.

### Investigation targets
**Required** (read before coding):
- `scripts/web-ui-smoke.ts`
- `browser-extension/build.ts`
- `browser-extension/manifest.json`
- `browser-extension/src/contracts.ts`
- `browser-extension/src/controller.ts`
- `browser-extension/src/extract.ts`
- `browser-extension/src/gateway.ts`
- `browser-extension/src/pending-recovery-view.tsx`
- `browser-extension/src/service-worker.ts`
- `browser-extension/src/storage.ts`
- `browser-extension/test`
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
- `test/serve/public/clipper-approval-location.test.ts`
- `test/serve/public/clipper-pairing-page.dom.test.tsx`
- `test/spec/schemas/validator.ts`
- `docs/API.md`
- `docs/INSTALLATION.md`
- `assets/skill/recipes/capture-and-file.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

**Optional** (reference as needed):
- `docs/MCP.md`

**Planned dependency outputs** (implemented by task 3; consume rather than redesign):
- `bun run build:clipper` and deterministic unpacked `browser-extension/dist`
- `ClipperGateway` closed response/status parsing
- `ClipperController` single-write retry/recovery state machine
- `extractVisiblePage` / `buildBrowserClipPayload`
- protected local grant/pending storage and transient session pairing
- real popup, pending-recovery view, service worker, content script, and `/clipper/pair` approval page

### Key context
- The deterministic development build exists. Remaining release work is distributable packaging/versioning/checksum, headed installed-extension proof, privacy disclosure, and complete repo/skill/hosted documentation.
- Browser-clip provenance hashes are exactly `extractionHash`, `finalBodyHash`, `clipIdentity`, and `previewDigest`. `sourceHash` belongs to other GNO source/index models and must not appear in browser-clip docs, fixtures, or claims.
- `CLIPPER_OFFLINE`, `CLIPPER_INVALID_RESPONSE`, and `CLIPPER_CLIENT` are client-side classifications, not `clipper-error@1.0` wire codes.

## Acceptance
- [ ] Browser E2E proves the exact start → same-origin CSRF approval → one-time origin-bound poll → bearer preview/write/revoke flow and all security denials, including that bearer gateway authentication and `gateway.enableWrite` do not substitute for a scoped clipper token. <!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.5 finalized separate gateway identity and write authorization -->
- [ ] Headed Chromium loads the real clean-built extension, drives the popup/service worker/content script/Web approval page against an isolated loopback collection, and covers both selection and Reader capture without fixtures bypassing the wire.
- [ ] Visible-only adversarial E2E proves explicit active-top-frame extraction, exact rendered selection, constrained Reader structure, exclusion of hidden/tracking/embed/media/iframe/background-tab content, and truthful partial/SPA/authenticated warnings.
- [ ] Tests prove actual-peer/Host/Origin/CORS/PNA/body/rate/concurrency enforcement and `clipperRoutesForBind(false, gateway) === {}`; no public/non-loopback clipper surface exists.
- [ ] Contract/E2E tests preserve runtime/Draft-07 parity for the closed URL/control/size/payload rules and reject unsupported Reader/Markdown inputs without remote fetching or silent coercion.
- [ ] E2E proves exact-selection provenance, server-owned preview-digest drift rules, the exact four browser-clip hash fields, provenance-bearing receipts, and `opened_existing`/`conflict`/`created_with_suffix` behavior, including changed final edits and no browser-clip `sourceHash`.
- [ ] Popup/service-worker restart and offline E2E proves the saved pending-write recovery UI, same logical payload/digest/key reuse, refresh-and-resume behavior, receipt replay, different-capture refusal, explicit discard, and exact-path fail-closed recovery without duplicate writes.
- [ ] Every success/error path enforces versioned closed bodies plus its exact HTTP status: 200 opened-existing receipt, 202 created/suffixed/overwritten receipt, 409 provenance-conflict receipt, or the documented `clipper-error@1.0`; malformed/unknown/mismatched responses fail closed.
- [ ] A clean package command produces a versioned byte-reproducible local artifact plus checksum from `browser-extension/dist`; manifest/artifact versions agree, manual install/update is verified, permissions remain minimal, and no store/Firefox publication is claimed.
- [ ] Privacy disclosure accurately covers explicit visible-only capture, local gateway traffic, exact protected local/session state, authenticated-visible user disclosure, retention/revocation/recovery, and the absence of history/cookies/sessions/background surveillance/telemetry/remote fetching.
- [ ] Repo/skill/gno.sh documentation names the exact routes, pairing/CSRF/origin/token-storage lifecycle, visible-only extraction limits, versioned closed receipt/status semantics, the four browser-clip hashes, Reader AST/edited-Markdown boundary, server preview/provenance ownership, popup/service-worker recovery, client vs wire errors, warning codes, collision results, and structural loopback-only privacy/security limits; live hosted docs are deployed and verified.
- [ ] Full lint/tests/docs/package checks pass.

<!-- Updated by plan-sync: fn-106.1 finalized the validation, preview/provenance, receipt-schema, and duplicate contracts that final E2E/docs must prove. -->
<!-- Updated by plan-sync: fn-106.2 finalized route/security/storage/schema/idempotency contracts and reusable gateway test surfaces. -->
<!-- Updated by plan-sync: fn-106.3 finalized visible-only extraction, closed receipt/status parsing, popup/service-worker recovery, and the deterministic unpacked build; packaging/E2E/privacy/hosted docs remain. -->

## Done summary
Packaged the Chromium MV3 browser clipper as a deterministic versioned ZIP with an adjacent SHA-256 checksum, npm-installed artifact verification, release attachment wiring, privacy disclosure, and exact manual install/update documentation. Added a real headed Playwright harness against an isolated loopback `gno serve`, including foreground Chrome LNA-compatible pairing, strict service-worker handoff validation, exact wire/header assertions, adversarial selection and Reader extraction, all four provenance hashes, collision outcomes, offline recovery, genuine service-worker replacement, different-payload refusal, same-key receipt replay, explicit Stop recovery, exact-path conflict without suffixing, resident redaction, and revoke.

Updated repo, shipped skill, and hosted gno.sh documentation without claiming Chrome Web Store or Firefox availability. The canonical skill autoresearch evaluator scored 47/47, the updated skill was reinstalled byte-identically across all five user targets, and independent review returned SHIP after the recovery coverage fix.

Hosted documentation commits: `3451d83`, `5fb9eda`. Deployment remains intentionally deferred to landing.

Validation: lint, typecheck, docs verification, 78 focused clipper tests, reproducible package verification, installed-package clipper smoke, gno.sh check/typecheck/109 tests/build/68-page prerender/Web smoke, and independent P1/P2 review passed. The full 3,051-test run recorded 3,047 pass, two expected skips, and two unrelated connector-verifier subprocess timeouts under concurrent machine load; the isolated connector-verifier suite subsequently passed 22/22.
## Evidence
- Commits: c4e2770, ed039a7, 09d84d9, e5f3356, e50ccef, ac172a8, ba7c6be
- Tests: bun run lint:check, bun run typecheck, bun run docs:verify, bun test browser-extension/test test/clipper test/serve/public/clipper-approval-location.test.ts test/serve/public/clipper-pairing-page.dom.test.tsx test/spec/schemas/clipper.test.ts test/store/clipper-store.test.ts --timeout 30000 (78 pass, 1 opt-in skip), bun run verify:clipper-package, bun run test:package:clipper, bun test test/core/connector-verifier.test.ts --timeout 10000 (22 pass on isolated rerun), cd /Users/gordon/work/gno.sh && bun run check, cd /Users/gordon/work/gno.sh && bun run typecheck, cd /Users/gordon/work/gno.sh && bun run test (109 pass, 5 expected skips), cd /Users/gordon/work/gno.sh && bun run build (68 pages prerendered), cd /Users/gordon/work/gno.sh && bun run smoke:web, canonical gno skill evaluator (47/47)
- PRs: