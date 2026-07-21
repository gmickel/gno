# fn-106 Browser Clipper with Provenance

## Goal & Context
<!-- scope: business -->

Let users capture a selected passage or clean Reader-style article from the browser into GNO with a preview and trustworthy provenance. Prefer a small local-first clipper over broad browser-history or OAuth connector access.

## Architecture & Data Models
<!-- scope: technical -->

Create a minimal browser extension sharing one capture payload contract with GNO's existing core:

- selection or sanitized Reader extraction
- source URL, canonical URL, page title, author/site, published/observed/captured dates
- capture mode, browser metadata, optional user note/tags/target collection/folder
- source hash and extraction warnings

Pair the extension to the loopback resident gateway using a short-lived, user-approved token. A preview shows exact content/frontmatter and destination before write. The gateway validates Origin/token/payload size, sanitizes HTML to canonical Markdown through the converter/capture pipeline, and returns the normal capture receipt.

## API Contracts
<!-- scope: technical -->

- Loopback pairing endpoints create/revoke scoped clipper tokens after visible user consent.
- `POST /api/capture/clip` accepts the versioned clip payload and returns existing capture/sync/embed receipt semantics plus provenance warnings.
- Extension supports selection and Reader modes, preview/edit, destination/tags, success/error receipt, and token revocation.
- No public/non-loopback clip endpoint without later auth/egress work.

## Edge Cases & Constraints
<!-- scope: technical -->

- Sanitize scripts/styles/forms/hidden tracking content and reject dangerous schemes.
- Handle paywalls/authenticated pages by capturing only browser-visible user-selected content; never bypass access controls.
- Canonical URL loops, duplicate clips, huge pages, images/data URLs, iframes, SPAs, offline gateway, token expiry, and Unicode need explicit behavior.
- Treat clipped text as untrusted content in later prompts.
- Pairing is CSRF/Origin protected, loopback-only, least-privilege, revocable, and rate-limited.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** A user can select text or choose Reader extraction, preview/edit it, select destination/tags, and create a GNO note with one confirmation.
- **R2:** Captured notes carry normalized source URL/title/dates/mode/hash provenance through the existing capture receipt path.
- **R3:** Pairing tokens are short-lived/scoped/revocable; Origin/CSRF/rate-limit tests block unauthorized local-web requests.
- **R4:** Sanitization fixtures remove executable/tracking content while preserving readable structure and exact selected text.
- **R5:** Duplicate, huge, authenticated-visible, SPA, offline, expiry, and Unicode cases return actionable receipts without silent data loss.
- **R6:** Extension packaging, permissions, privacy disclosure, local gateway docs, and end-to-end browser tests are complete.

## Boundaries
<!-- scope: business -->

No browsing-history ingestion, cookie/session export, paywall bypass, cloud sync, OAuth connector, background surveillance, or autonomous clipping.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Web evidence is a common input to a knowledge base. A previewed local clipper closes that capture gap with much less trust surface than account-wide connectors.

### Implementation Tradeoffs
<!-- scope: technical -->

A browser extension offers reliable selection/Reader access but requires careful local pairing. Reusing capture provenance avoids creating a second ingestion model.
