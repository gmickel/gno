---
satisfies: [R1, R5, R6]
---
# fn-106-browser-clipper-with-provenance.3 Build the minimal browser extension preview workflow

## Description
Deliver build the minimal browser extension preview workflow as one implementation-sized increment.

**Size:** M
**Files:** `browser-extension/manifest.json`, `browser-extension/src/service-worker.ts`, `browser-extension/src/content.ts`, `browser-extension/src/preview.tsx`, `browser-extension/test`

### Approach
- Target Chromium Manifest V3 first with `activeTab`, `scripting`, and loopback host permissions only; document Firefox as a follow-up unless parity is explicitly validated.
- On explicit action, emit the closed `BrowserClipPayload` version `1.0`: selection mode keeps `selection.exactText` separate from nullable `selection.editedMarkdown`; Reader mode emits only the supported paragraph/heading/quote/list/code/horizontal-rule AST with text/link inline nodes and nullable `reader.editedMarkdown`. Never submit raw HTML, images, reference links, or an extension-defined provenance object.
- Send source/canonical URLs and all free-form strings through the server contract. Treat task 1's absolute HTTP(S) URL subset, 512 KiB limit, and C0/C1 control rejection as authoritative; display closed validation failures instead of loosening or independently normalizing them.
- Render preview from the server's prepared body/source/destination/tags, provenance, warning codes, capture-plan result, and `previewDigest`. Keep exact selection available for provenance while allowing an edited final body; do not compute hashes, clip identity, normalized URLs, canonical Reader Markdown, or preview digest in the extension.
- Let the user edit content/frontmatter/destination/tags, request a fresh server preview after each meaningful change, then submit once with the latest digest and idempotency key.
- Store only scoped pairing material using extension storage. Expose actionable offline/expiry/revocation, SPA/iframe/authenticated-visible/Unicode warnings, and collision outcomes: `opened_existing`, `conflict`, or `created_with_suffix`.

### Investigation targets
**Required** (read before coding):
- `src/core/browser-clip.ts`
- `src/core/browser-clip-provenance.ts`
- `src/core/capture.ts`
- `src/serve/routes/clipper.ts`

**Optional** (reference as needed):
- `src/serve/public/components/CaptureModal.tsx`
- `src/serve/public/components/TagInput.tsx`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/serve/routes/clipper.ts`
- clipper preview/write response schemas from task 2

### Key context
- Never read history, cookies, sessions, background tabs, or bypass paywalls; only user-visible content selected on explicit action.
- Task 1 owns canonical Markdown, hashes, normalized provenance, warning vocabulary, and duplicate identity. The extension owns extraction inputs and UI state only.

## Acceptance
- [ ] User can select or Reader-capture, preview/edit, choose destination/tags, refresh the server preview, confirm once with its digest/idempotency key, and see the canonical receipt.
- [ ] Selection and Reader fixtures emit only the closed version `1.0` payload: exact selection remains separate from edited Markdown, Reader output uses the supported AST, and raw HTML/images/reference links never cross the boundary.
- [ ] Preview UI displays the server-prepared body/source/destination/tags, provenance, closed warning codes, and capture-plan result; tests prove it does not locally derive hashes, normalized URLs, canonical Markdown, clip identity, or preview digest.
- [ ] A changed edit, metadata field, destination, tag, or extraction input requires a refreshed digest before write. Duplicate UI distinguishes an identical `opened_existing` receipt from provenance `conflict` and user-selected `created_with_suffix`.
- [ ] Manifest permissions are minimal and no browsing-history/cookie/background-surveillance access exists.
- [ ] SPA, iframe, authenticated-visible, huge, Unicode/control-character, invalid-URL, duplicate, offline, expiry, and revoked-token fixtures are actionable.

<!-- Updated by plan-sync: fn-106.1 fixed the versioned payload/Reader AST, preview/provenance ownership, warnings, and duplicate identity semantics consumed by the extension. -->

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
