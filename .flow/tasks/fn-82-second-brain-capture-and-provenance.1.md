# fn-82-second-brain-capture-and-provenance.1 Lock shared capture contract and provenance core

## Description

Define and implement the shared capture/provenance core before any surface-specific work.

This task owns the remaining contract-hardening work from superseded `fn-59` and `fn-62`, plus the new capture/provenance model. `fn-59` and `fn-62` are closed because current code already contains their baseline implementations; this task is the current source of truth for the hardening needed before `gno capture` can ship.

The task owns the canonical core model and facade for capture input, source/provenance metadata, deterministic identity/hash rules, content/preset validation, text safety, frontmatter serialization/merge behavior, collision planning, legacy overwrite handling/rejection, write outcome, and receipt construction. It should reuse existing note-creation and preset primitives instead of introducing a second note-writing path.

Existing baseline to reuse:

- `src/core/note-creation.ts` for current relPath/folder/title/collision planning
- `src/core/note-presets.ts` for current preset definitions and scaffold resolution
- `src/serve/routes/api.ts` `POST /api/docs` for raw API note creation
- `src/sdk/client.ts` `createNote()` for SDK raw note creation
- `src/mcp/tools/capture.ts` `gno_capture` for current MCP write/capture behavior
- Web quick capture, Browse, command palette, and editor preset insert implementations as current UI baseline

Expected files:

- `src/core/note-creation.ts`
- `src/core/note-presets.ts`
- `src/core/document-capabilities.ts`
- `src/core/capture*.ts` or adjacent shared core module
- `src/ingestion/frontmatter.ts`
- `spec/cli.md`
- `spec/mcp.md`
- `spec/output-schemas/*capture*.schema.json`
- `docs/API.md`
- `docs/SDK.md`
- `docs/MCP.md`
- `docs/WEB-UI.md`
- `assets/skill/*`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`
- `test/core/*capture*.test.ts`
- `test/spec/schemas/*capture*.test.ts`

Implementation notes:

- Build one shared capture facade/planner that owns path planning, content assembly, structured frontmatter merge, hash, text safety, collision result, write outcome, and receipt construction.
- Harden current `resolveNoteCreatePlan` behavior for capture by including disk-only collisions in addition to indexed relPaths.
- Close current MCP parity gap where `gno_capture` rejects `open_existing` even though the shared resolver supports it.
- Keep raw note creation (`POST /api/docs`, `client.createNote`) distinct from capture-with-provenance while sharing resolver/preset primitives.
- Define the content validation matrix: content source required unless a scaffold-capable preset is present; empty body without such preset is rejected; preset plus content is allowed.
- Support nested `source:` frontmatter while preserving unknown existing frontmatter fields and body.
- Map existing flat `gno_source_docid`, `gno_source_uri`, `gno_source_mime`, and `gno_source_ext` into canonical `source.docid`, `source.uri`, `source.mime`, and `source.ext`.
- Use UTC `capturedAt` for default `YYYY-MM-DD` path date and make clock injectable in tests.
- Define default collision behavior: generated hash paths default to `open_existing`; explicit paths default to `error`.
- Check both indexed documents and disk-only files before collision decisions.
- Treat MCP `overwrite` as core-owned legacy compatibility with `collisionPolicyResult: overwritten` and `overwritten: true`, or reject it globally; adapters must not bypass core for overwrite.
- Move NUL rejection, size limits, text safety, and normalization rules into shared core.
- Define receipt enums for sync/FTS ingestion and embed/vector indexing: `not_requested|pending|running|completed|skipped|failed|unknown`.

## Acceptance

- [ ] **R1:** Shared `CaptureInput`, `CaptureSource`, `CaptureReceipt`, and capture facade/planner exist outside adapters and are documented in specs.
- [ ] **R2:** Shared core owns path planning, content assembly, structured frontmatter merge, hash, text safety, collision result, write outcome, legacy overwrite behavior/rejection, and receipt construction.
- [ ] **R3:** Provenance frontmatter supports canonical nested `source:` fields, preserves existing frontmatter/body, and maps existing editable-copy `gno_source_*` fields through one compatibility layer.
- [ ] **R4:** Deterministic default path rules use UTC `capturedAt` and are tested with an injectable clock for explicit path, title/folder, and `inbox/YYYY-MM-DD-<hash8>.md` fallback.
- [ ] **R5:** Body hash normalization is tested for LF/CRLF, BOM, Unicode normalization, and same-body/different-provenance collision behavior.
- [ ] **R6:** Collision tests cover indexed existing docs, disk-only existing files, generated-path default `open_existing`, explicit-path default `error`, `create_with_suffix`, and legacy overwrite behavior/rejection.
- [ ] **R7:** Content validation tests cover content source, scaffold-capable preset without body, preset plus body, blank preset behavior, empty body rejection, and adapter parity expectations.
- [ ] **R8:** Receipt schema includes optional docid, URI, collection, relPath, hash, source, tags, overwritten, collision result, sync status/details, embed status/details, and MCP compatibility fields where required.
- [ ] **R9:** Shared core tests cover NUL rejection, size limits, unsupported binary-like text, path escapes, and missing/non-editable collection errors.
- [ ] **R10:** Current `fn-59`/`fn-62` baseline behavior remains covered or is deliberately superseded by new capture contract tests; no old broad Flow task remains a separate implementation dependency.
- [ ] **R11:** Task docs/spec updates define canonical snippets and status vocabulary; later surface tasks must reuse these instead of inventing new wording.

## Done summary

## Evidence

- Commits:
- Tests:
- PRs:
