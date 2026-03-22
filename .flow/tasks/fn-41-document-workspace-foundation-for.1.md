# fn-41-document-workspace-foundation-for.1 Define the safe document capability contract

## Description

Define and enforce the document capability contract that separates editable source-of-truth documents from read-only converted/source assets. This task fixes the current unsafe behavior where any surfaced document can still route into edit mode and content updates can be written back to the original file path even for converted PDF/DOCX sources.

**Files:** `src/serve/routes/api.ts`, `src/serve/public/pages/DocView.tsx`, `src/serve/public/pages/DocumentEditor.tsx`, `src/mcp/tools/get.ts`, `src/sdk/*`, `docs/API.md`, `docs/MCP.md`, `docs/WEB-UI.md`, `docs/comparisons/obsidian.md`

## Acceptance

- Add an explicit document capability model to surfaced document metadata so callers can distinguish editable local text/markdown docs from read-only converted/source assets.
- `PUT /api/docs/:id` rejects content writes for non-editable documents with a clear validation/error contract, while markdown/plaintext docs remain editable.
- Doc View and editor entrypoints no longer offer in-place edit for read-only converted docs; instead they provide appropriate read-only actions such as `Open original` and `Create editable markdown copy`.
- The editable-copy flow creates a new markdown document inside a configured collection without mutating the original asset, preserves source provenance metadata, and queues indexing.
- Update the user-facing docs/comparison copy that currently overstates edit equivalence so `docs/` remains the source of truth for the capability contract.
- Regression tests cover markdown success and PDF/DOCX rejection paths; user-facing docs/specs are updated to reflect the new contract.

## Notes For Implementer

- Unsafe current write path: `src/serve/routes/api.ts:929-963`.
- Current edit affordance is exposed from Doc View without capability checks: `src/serve/public/pages/DocView.tsx:272-275`, `src/serve/public/pages/DocView.tsx:385-390`.
- Reuse the existing content-addressed distinction between source and canonical markdown: `docs/ARCHITECTURE.md:56-77`, `docs/ARCHITECTURE.md:167-174`.
- Keep this contract server-enforced first; UI, MCP, and SDK should mirror server truth rather than infer editability client-side.
- `docs/comparisons/obsidian.md` currently says GNO works with Obsidian rather than replacing it: `docs/comparisons/obsidian.md:5-6`, `docs/comparisons/obsidian.md:36-54`, `docs/comparisons/obsidian.md:164-166`.

## Done summary
Implemented the safe document capability contract, read-only converted-doc handling, editable-copy flow, and capability metadata across API/CLI/MCP/SDK.
## Evidence
- Commits: e677f41, 2662e77
- Tests: bun test test/serve/api-docs-update.test.ts, bun test test/spec/schemas/get.test.ts, bun run lint:check, bun run docs:verify
- PRs: