---
satisfies: [R1, R3, R4, R5, R6]
---
# fn-106-browser-clipper-with-provenance.4 Package test and document the local clipper

## Description
Deliver package test and document the local clipper as one implementation-sized increment.

**Size:** M
**Files:** `browser-extension`, `test/clipper/e2e.test.ts`, `docs/integrations/browser-clipper.md`, `docs/API.md`, `docs/INSTALLATION.md`, `assets/skill/recipes/capture-and-file.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Add headed browser E2E for pair, selection/Reader preview, edit, capture receipt, revoke, and malicious local-origin attempts.
- Define reproducible extension build/package/version/privacy disclosure and manual distribution/update channel; do not claim store publication until completed.
- Update API/Web/config/troubleshooting/skill/hosted docs with local-only security and no-history/no-OAuth boundaries.

### Investigation targets
**Required** (read before coding):
- `scripts/web-ui-smoke.ts`
- `docs/API.md`
- `docs/INSTALLATION.md`
- `assets/skill/recipes/capture-and-file.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

**Optional** (reference as needed):
- `docs/MCP.md`
## Acceptance
- [ ] Browser E2E proves the full paired preview/write/revoke flow and all security denials.
- [ ] Extension package is reproducible, versioned, minimally permissioned, and carries an accurate privacy disclosure.
- [ ] Repo/skill/gno.sh documentation is current and full lint/tests/docs/package checks pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
