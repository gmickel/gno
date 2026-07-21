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
- Capture user selection or Reader-style visible content on user action, preview/edit exact content/frontmatter/destination/tags, then submit once.
- Store only scoped pairing material using extension storage; expose actionable offline/expiry/duplicate/SPA/iframe/authenticated-visible/Unicode results.

### Investigation targets
**Required** (read before coding):
- `src/core/capture.ts`
- `src/serve/routes/api.ts`

**Optional** (reference as needed):
- `src/serve/public/components/CaptureModal.tsx`
- `src/serve/public/components/TagInput.tsx`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `browser-extension/manifest.json`
- `src/serve/routes/clipper.ts`
- `src/core/browser-clip.ts`

### Key context
- Never read history, cookies, sessions, background tabs, or bypass paywalls; only user-visible content selected on explicit action.

## Acceptance
- [ ] User can select or Reader-capture, preview/edit, choose destination/tags, confirm once, and see the canonical receipt.
- [ ] Manifest permissions are minimal and no browsing-history/cookie/background-surveillance access exists.
- [ ] SPA, iframe, authenticated-visible, huge, Unicode, duplicate, offline, expiry, and revoked-token fixtures are actionable.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
