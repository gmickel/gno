---
satisfies: [R1, R2, R3]
---

# fn-71-bundled-image-attachments-in-publish-export.2 Build safe GNO attachment resolution and artifact bundling
## Description
Implement the Bun-first GNO producer path: parser-aware local attachment discovery, collection-root confinement, byte validation/deduplication, deterministic asset IDs, sentinel rewriting, v1 serialization, and exact pre-egress size/reporting.

**Size:** M
**Files:** `src/publish/attachment-resolver.ts`, `src/publish/artifact.ts`, `src/publish/export-service.ts`, `src/publish/obsidian-sanitize.ts`, `test/publish/attachment-resolver.test.ts`, `test/publish/export-service.test.ts`

## Approach
- Extend the existing sanitizer/export pipeline rather than scanning Markdown twice.
- Resolve only local supported raster references; external HTTP(S) remains external and no network fetch occurs.
- Validate real bytes, dimensions, length, digest, roots/symlinks, and final envelope size before upload.
- Deduplicate content while retaining every note/reference mapping and diagnostic.

## Investigation targets
**Required** (read before coding):
- `src/publish/export-service.ts:178-203` — current export/sanitization boundary
- `src/publish/obsidian-sanitize.ts:22,86,162` — current dropped-embed reporting
- `src/publish/artifact.ts:36-42` — artifact model
- `src/core/links.ts` — parser/link treatment patterns
- `test/publish/` — current artifact/export fixture conventions

**Optional** (reference as needed):
- `src/core/file-ops.ts:7-19` — Bun-first file-I/O convention
- `docs/SYNTAX.md` — supported Obsidian/Markdown syntax claims

## Key context
Use `Bun.file()` for bytes. Extension/MIME are hints only. Traversal and symlink escape are hard failures; unsupported SVG/other formats are explicit diagnostics, never silently converted.

## Acceptance
- [ ] Obsidian and Markdown local raster references resolve deterministically within the approved collection root, including spaces/Unicode/aliases/relative paths.
- [ ] External, missing, ambiguous, escaped, malformed, unsupported, and hostile files are never fetched or bundled and receive stable diagnostics.
- [ ] Identical bytes deduplicate by digest; note/reference mappings and non-asset Markdown bytes remain correct.
- [ ] Producer reports raw/encoded/final bytes and rejects oversize before network egress using the exact serialized envelope.
- [ ] Bun-first unit/integration tests, schemas, and lint checks pass.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
