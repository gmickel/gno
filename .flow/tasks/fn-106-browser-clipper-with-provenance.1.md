---
satisfies: [R2, R4, R5]
---
# fn-106-browser-clipper-with-provenance.1 Define clip payload sanitization and capture provenance

## Description
Define the versioned browser-clip contract, deterministic preview/provenance model, and safe selection/Reader canonicalization boundary.

**Size:** L
**Files:** `src/core/browser-clip.ts`, `src/core/capture.ts`, `src/converters/canonicalize.ts`, `spec/output-schemas/browser-clip.schema.json`, `spec/output-schemas/capture-receipt.schema.json`, `spec/output-schemas/mcp-capture-result.schema.json`, `test/clipper/browser-clip.test.ts`, `test/spec/schemas/capture-receipt.test.ts`, `test/spec/schemas/mcp-capture-result.test.ts`

### Approach
- Define closed versioned selection and Reader payloads with source/canonical URL, title, author/site, published/observed date, capture mode, destination, note, tags, extraction metadata, and warnings.
- Selection mode preserves exact user-visible plain text separately from edited final Markdown.
- Reader mode accepts a constrained semantic block AST only: paragraphs, headings, lists, quotes, code, horizontal rules, and validated links. Do not accept raw HTML, arbitrary attributes, scripts, styles, forms, embeds, iframes, images, SVG, MathML, data/blob URLs, or server-side URL fetching.
- Validate source/canonical URLs as HTTP(S), reject credentials and dangerous schemes, normalize fragments/date fields deterministically, and render the Reader AST to canonical Markdown on the server.
- Compute normalized URLs, extraction hash, final canonical-body hash, deterministic clip identity, preview digest, capture time, and bounded warnings on the server.
- Extend shared capture provenance and all public receipt schemas without losing CLI/MCP/SDK compatibility.
- Keep extraction provenance distinct from user-edited final content. Duplicate/open-existing is valid only when stored provenance matches; same destination with different provenance must remain an explicit collision/create-new outcome.

### Investigation targets
**Required** (read before coding):
- `src/core/capture.ts:53-120`
- `src/core/capture.ts:627-744`
- `src/core/capture-write.ts`
- `src/converters/canonicalize.ts`
- `src/converters/native/markdown.ts`
- `spec/output-schemas/capture-receipt.schema.json`
- `spec/output-schemas/mcp-capture-result.schema.json`

**Optional** (reference as needed):
- `src/core/note-presets.ts`
- capture CLI/MCP/SDK parity fixtures

## Acceptance
- [ ] Closed schemas validate deterministic selection and Reader payload, preview, provenance, and receipt projections.
- [ ] Exact Unicode selection survives normalization with explicit CRLF/NFC behavior; extraction and edited-final hashes remain distinct.
- [ ] Constrained Reader fixtures preserve readable structure while rejecting executable/tracking/hidden/embed/image content and dangerous URLs.
- [ ] Server-owned normalized URLs, strict dates, hashes, warnings, preview digest, and deterministic identity are stable across unchanged inputs.
- [ ] Duplicate/open-existing/create-new/path-collision outcomes never silently merge different provenance.
- [ ] Existing capture CLI/MCP/SDK contracts and schema fixtures remain compatible.

## Done summary
Defined and hardened the closed browser-clip provenance contract: exact selection and constrained Reader AST inputs; deterministic canonical Markdown, hashes, identity, preview digest, and receipt projection; provenance-aware duplicate/collision behavior; shared runtime/Draft-07 URL and control-character policy; bounded API/CLI/MCP/SDK documentation. Independent review found and verified fixes for preview drift, edit-loss duplicates, Markdown bypasses, and schema/runtime parity.
## Evidence
- Commits: 67d8b3f, 00d1826, 42b96eb
- Tests: bun test test/clipper/browser-clip.test.ts test/capture test/spec/schemas/capture-receipt.test.ts test/spec/schemas/mcp-capture-result.test.ts (45 pass, 300 assertions), bun test test/spec/schemas (215 pass, 640 assertions), bun run lint:check, bunx tsc --noEmit --pretty false, independent final rereview: SHIP; 24 pass, 142 assertions
- PRs: