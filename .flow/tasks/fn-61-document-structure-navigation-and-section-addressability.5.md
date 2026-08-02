---
satisfies: [R1, R2, R3, R5]
---
# fn-61-document-structure-navigation-and-section-addressability.5 Add durable section target and conservative resolver

## Description
Define and implement the browser-safe `SectionTargetV1` and conservative resolver beside the shipped extraction/slug logic. Prove exact recovery and fail-closed behavior before any transport integration.

**Size:** M
**Files:** `src/core/sections.ts`, `test/core/sections.test.ts`, `spec/output-schemas/section-target.schema.json`

### Approach
- Keep `DocumentSection`, current anchors, and renderer compatibility intact.
- Use bounded structural/quote/context/revision evidence; line offsets are hints only.
- Resolve in deterministic stages and return typed non-success states instead of fuzzy guesses.
- Measure serialized target size and avoid embedding full section bodies.

### Investigation targets
**Required** (read before coding):
- `src/core/sections.ts:9-92` — canonical extraction and duplicate slugs
- `test/core/sections.test.ts:5-39` — existing compatibility fixtures
- `src/serve/public/components/editor/MarkdownPreview.tsx:190-217` — renderer ID parity
- `src/serve/public/lib/deep-links.ts` — existing deep-link conventions if present
- W3C Web Annotation selector model — quote/context recovery concepts

**Optional** (reference as needed):
- `test/serve/public/lib/deep-links.test.ts` — URL/deep-link test patterns
- `docs/GLOSSARY.md` — Section Link terminology

### Key context
No persistent section table in v1. A fingerprint mismatch can still recover uniquely; identical candidates must return `ambiguous`.

## Acceptance
- [ ] `SectionTargetV1` is versioned, bounded, content-derived, browser-safe, and preserves the current human anchor.
- [ ] Resolver emits exact/recovered/ambiguous/stale/missing with deterministic ordering and evidence.
- [ ] Duplicate insertion, heading rename, reorder, deletion, identical sections, fence handling, and supported heading syntax have explicit regression cases.
- [ ] Ambiguous/stale targets never silently navigate; existing section extraction and anchor tests remain unchanged or explicitly migrated.
- [ ] Focused schema/core tests and lint checks pass.


## Done summary
Added a bounded browser-safe SectionTargetV1, a deterministic fail-closed resolver, and schema-backed regressions for exact recovery, edits, ambiguity, stale/missing states, fences, Unicode, and hostile oversized identity fields.
## Evidence
- Commits:
- Tests: bun test test/core/sections.test.ts test/spec/schemas/section-target.test.ts test/serve/public/lib/deep-links.test.ts (20 pass, 0 fail), bun test (3634 pass, 2 platform skips, 0 fail), bun run lint:check (clean)
- PRs: