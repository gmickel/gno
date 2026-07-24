# fn-106 Browser Clipper with Provenance

## Goal & Context
<!-- scope: business -->

Let users capture an exact selected passage or clean Reader-style article from the browser into GNO with a preview and trustworthy provenance. Prefer a small, explicit, local-first clipper over browsing-history, cookie, session, or OAuth access.

## Architecture & Data Models
<!-- scope: technical -->

Create a Chromium Manifest V3 extension and a shared closed browser-clip contract:

- selection mode carries exact user-visible plain text plus edited final Markdown
- Reader mode carries a constrained semantic block AST, never arbitrary HTML
- source/canonical URL, page title, author/site, published/observed/captured dates
- capture mode, browser metadata, optional note/tags/target collection/folder
- extraction hash, final canonical-body hash, preview digest, source hash, warnings
- deterministic identity and explicit duplicate/collision outcome

Allowed Reader blocks are paragraphs, headings, lists, quotes, code, horizontal rules, and validated links. Scripts, styles, forms, hidden/tracking content, arbitrary attributes, embeds, iframes, images, SVG, MathML, data/blob URLs, and server-side URL fetching are out of contract. The gateway validates and renders canonical Markdown; it does not trust extension-rendered HTML.

Pair through the loopback resident gateway with a short-lived, one-time, visibly approved pairing code. A bounded, revocable, exact-extension-origin-bound grant is stored only as a hash. Unfinished pairing codes die on restart; valid persisted grants retain their explicit expiry/revocation state.

Preview and write are separate. Preview is non-mutating and server-owned. Write requires the matching preview digest and an idempotency key, replans before commit, then reuses the normal atomic capture/sync/embed receipt path.

## API Contracts
<!-- scope: technical -->

- `POST /api/clipper/pair/start` creates a short-lived pairing request without granting access.
- Same-origin Web UI `POST /api/clipper/pair/approve` visibly approves and binds the exact extension Origin.
- One-time `GET /api/clipper/pair/:id` returns the scoped grant once; `POST /api/clipper/revoke` revokes it.
- `POST /api/capture/clip/preview` validates, canonicalizes, and returns the exact non-mutating preview, warnings, digest, and destination outcome.
- `POST /api/capture/clip` accepts the versioned payload, preview digest, and idempotency key, then returns existing capture/sync/embed receipt semantics plus provenance warnings.
- Gateway bearer identity and `gateway.enableWrite` never authorize clipping; clipper grants never authorize MCP or general REST.
- Clipper routes are structurally absent for non-loopback binding.

## Edge Cases & Constraints
<!-- scope: technical -->

- Require actual loopback peer, exact Host, exact bound extension Origin, CSRF protection for approval, explicit OPTIONS/CORS/Private-Network-Access policy, and bounded body/rate/concurrency limits.
- Handle paywalls/authenticated pages only by capturing content visibly available to the user; never bypass controls or export cookies/sessions.
- Canonical URL loops, credentials/fragments, duplicate provenance, same-path/different-provenance collisions, huge pages, stripped images, iframes, SPAs, offline gateway, expiry/revocation/replay, retries, preview drift, and Unicode need explicit deterministic outcomes.
- Treat clipped text as untrusted content in later prompts.
- Never fetch source/canonical URLs, images, metadata, or remote resources from the gateway.
- Manifest permissions remain `activeTab`, `scripting`, `storage`, and exact loopback host access only.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** A user can select text or choose Reader extraction, preview/edit it, select destination/tags, and create a GNO note with one confirmation.
- **R2:** Captured notes carry normalized source URL/title/dates/mode/hash provenance through the existing capture receipt path, with exact selection provenance distinct from edited final content.
- **R3:** Pairing codes are short-lived/single-use and grants are scoped/origin-bound/bounded/revocable; actual-peer/Host/Origin/CSRF/CORS/PNA/rate/body tests block unauthorized local-web requests and identity cross-use.
- **R4:** Constrained Reader and selection fixtures reject executable/tracking/embed/image content and dangerous schemes while preserving exact selection metadata and readable structure.
- **R5:** Duplicate, collision, huge, authenticated-visible, SPA, iframe, offline, expiry, revoked, retry/idempotency, preview-drift, and Unicode cases return actionable receipts without silent data loss.
- **R6:** Extension packaging, permissions, privacy disclosure, local gateway docs, hosted docs, skill guidance, and end-to-end browser tests are complete and truthful.

## Boundaries
<!-- scope: business -->

No raw HTML ingestion, browsing-history ingestion, cookie/session export, paywall bypass, cloud sync, OAuth connector, background surveillance, remote content fetching, autonomous clipping, non-loopback capture, Firefox parity claim, or public-store claim in V1.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Web evidence is a common knowledge-base input. A previewed local clipper closes that capture gap with much less trust surface than account-wide connectors.

### Implementation Tradeoffs
<!-- scope: technical -->

A constrained Reader AST is less permissive than arbitrary HTML but gives deterministic hashes, smaller attack surface, and no browser/server sanitizer drift. Persisted hashed grants avoid repair after ordinary resident restarts while keeping one-time pairing secrets and usable tokens out of storage. Preview-digest plus idempotency makes the user-visible confirmation the exact write contract.

## Implementation Plan

1. `fn-106-browser-clipper-with-provenance.1` — Define clip payload sanitization and capture provenance (**L**)
2. `fn-106-browser-clipper-with-provenance.2` — Add secure loopback clipper pairing and capture endpoints (**L**); depends on task 1
3. `fn-106-browser-clipper-with-provenance.3` — Build the minimal Chromium MV3 preview workflow (**M**); depends on tasks 1–2
4. `fn-106-browser-clipper-with-provenance.4` — Package, browser-test, document, and publish the local clipper artifact (**M**); depends on task 3

## Quick commands

```bash
bun test test/clipper test/capture
bun run test:e2e
.flow/bin/flowctl validate --spec fn-106-browser-clipper-with-provenance --json
```

## References

- [MDN extension content safety](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Safely_inserting_external_content_into_a_page)
- `src/core/capture.ts` — capture plan/receipt
- `src/core/capture-write.ts` — atomic write semantics
- `src/serve/routes/api.ts` — local capture API
- `src/mcp/http-security.ts` — resident transport security boundary

## Early proof point

Task 1 must prove a versioned exact-selection payload and constrained Reader AST round-trip through shared capture provenance without executable HTML, remote fetch, ambiguous hashes, or silent duplicate merging. If this fails, stop before pairing/extension work and revise the contract boundary.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | Previewed selection/Reader capture with destination/tags and one confirmation. | fn-106-browser-clipper-with-provenance.3, fn-106-browser-clipper-with-provenance.4 | — |
| R2 | Normalized provenance and distinct extraction/final hashes through shared receipts. | fn-106-browser-clipper-with-provenance.1 | — |
| R3 | Secure one-time pairing, scoped grants, and local transport denial tests. | fn-106-browser-clipper-with-provenance.2, fn-106-browser-clipper-with-provenance.4 | — |
| R4 | Safe constrained Reader/selection canonicalization. | fn-106-browser-clipper-with-provenance.1, fn-106-browser-clipper-with-provenance.4 | — |
| R5 | Explicit failure, duplicate, retry, and edge-case outcomes. | fn-106-browser-clipper-with-provenance.1, fn-106-browser-clipper-with-provenance.2, fn-106-browser-clipper-with-provenance.3, fn-106-browser-clipper-with-provenance.4 | — |
| R6 | Reproducible extension artifact, E2E, privacy, skill, repo, and hosted docs. | fn-106-browser-clipper-with-provenance.3, fn-106-browser-clipper-with-provenance.4 | — |
