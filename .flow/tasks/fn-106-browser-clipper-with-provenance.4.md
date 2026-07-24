---
satisfies: [R1, R3, R4, R5, R6]
---
# fn-106-browser-clipper-with-provenance.4 Package test and document the local clipper

## Description
Deliver package test and document the local clipper as one implementation-sized increment.

**Size:** M
**Files:** `browser-extension`, `test/clipper/e2e.test.ts`, `docs/integrations/browser-clipper.md`, `docs/API.md`, `docs/INSTALLATION.md`, `assets/skill/recipes/capture-and-file.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Add headed browser E2E for pair, closed selection/Reader payloads, server preview, edit/re-preview, digest-bound write, provenance-bearing capture receipt, collision outcomes, revoke, and malicious local-origin attempts. Run against the loopback resident gateway and assert the redacted `resident-status@1.0` `GET /api/resident/status` surface for offline/readiness reporting; never use it to recover credentials or authorize capture.
- Add contract/E2E coverage for task 1's shared runtime/Draft-07 rules: payload version and 512 KiB ceiling; absolute HTTP(S) URL subset; recursive C0/C1 rejection with TAB/LF/CR preservation; closed Reader AST; edited-Markdown denial of raw HTML/images/reference links; deterministic canonical Markdown, hashes, warning codes, and receipt provenance.
- Prove preview and duplicate semantics end to end: preview digest changes for edits/source metadata/destination/tags/extraction but not a later server clock; exact selection remains in provenance; matching stored `clipIdentity` opens existing, absent/different provenance or the same extraction with a changed final body conflicts, and suffix policy reports `created_with_suffix`.
- Define reproducible extension build/package/version/privacy disclosure and manual distribution/update channel; do not claim store publication until completed.
- Update API/Web/config/troubleshooting/skill/hosted docs with the exact `BrowserClipPayload`/`PreparedBrowserClip` preview boundary, warning and collision-result vocabularies, local-only security, and no-history/no-OAuth boundaries.

### Investigation targets
**Required** (read before coding):
- `scripts/web-ui-smoke.ts`
- `src/core/browser-clip.ts`
- `src/core/browser-clip-provenance.ts`
- `src/core/capture.ts`
- `spec/output-schemas/capture-receipt.schema.json`
- `spec/output-schemas/mcp-capture-result.schema.json`
- `docs/API.md`
- `docs/INSTALLATION.md`
- `assets/skill/recipes/capture-and-file.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

**Optional** (reference as needed):
- `docs/MCP.md`
## Acceptance
- [ ] Browser E2E proves the full paired preview/write/revoke flow and all security denials, including that bearer gateway authentication and `gateway.enableWrite` do not substitute for a scoped clipper token. <!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.5 finalized separate gateway identity and write authorization -->
- [ ] Contract/E2E tests preserve runtime/Draft-07 parity for the closed URL/control/size/payload rules and reject unsupported Reader/Markdown inputs without remote fetching or silent coercion.
- [ ] E2E proves exact-selection provenance, server-owned preview-digest drift rules, provenance-bearing receipts, and `opened_existing`/`conflict`/`created_with_suffix` behavior, including changed final edits.
- [ ] Extension package is reproducible, versioned, minimally permissioned, and carries an accurate privacy disclosure.
- [ ] Repo/skill/gno.sh documentation names the exact versioned payload, Reader AST/edited-Markdown boundary, server preview/provenance ownership, warning codes, collision results, and local-only privacy/security limits.
- [ ] Full lint/tests/docs/package checks pass.

<!-- Updated by plan-sync: fn-106.1 finalized the validation, preview/provenance, receipt-schema, and duplicate contracts that final E2E/docs must prove. -->

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
