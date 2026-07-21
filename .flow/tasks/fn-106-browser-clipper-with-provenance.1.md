---
satisfies: [R2, R4, R5]
---
# fn-106-browser-clipper-with-provenance.1 Define clip payload sanitization and capture provenance

## Description
Deliver define clip payload sanitization and capture provenance as one implementation-sized increment.

**Size:** M
**Files:** `src/core/browser-clip.ts`, `src/core/capture.ts`, `src/converters/canonicalize.ts`, `spec/output-schemas/browser-clip.schema.json`, `test/clipper/browser-clip.test.ts`

### Approach
- Define selected-text and Reader payloads with source/canonical URL, title/author/site/dates, capture mode, original extraction hash, edited-preview hash, warnings, destination, note, and tags.
- Sanitize scripts/styles/forms/tracking/dangerous schemes and convert allowed structure through existing canonical Markdown/capture planning.
- Keep exact selection provenance distinct from user-edited final content; duplicate policy compares canonical source plus extraction/final hashes and never silently merges.

### Investigation targets
**Required** (read before coding):
- `src/core/capture.ts:53-120`
- `src/core/capture.ts:627-744`
- `src/converters/canonicalize.ts`
- `src/converters/native/markdown.ts`

**Optional** (reference as needed):
- `src/core/capture-write.ts`
- `src/core/note-presets.ts`

## Acceptance
- [ ] Selection and Reader fixtures produce deterministic preview/frontmatter/receipt provenance.
- [ ] Sanitization removes executable/tracking content while preserving readable structure and exact selected text metadata.
- [ ] Edits and duplicate/open-existing/create-new outcomes are explicit with both extraction and final hashes.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
