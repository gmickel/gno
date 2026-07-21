---
satisfies: [R2, R5]
---
# fn-98-context-capsule-mvp.3 Compile exact evidence spans with trust boundaries

## Description
Deliver compile exact evidence spans with trust boundaries as one implementation-sized increment.

**Size:** M
**Files:** `src/core/context-evidence.ts`, `src/pipeline/chunk-lookup.ts`, `src/core/sections.ts`, `test/core/context-evidence.test.ts`

### Approach
- Materialize extractive passages from canonical source/mirror text with exact line ranges, headings, URI/docid, hashes, and known dates.
- Map converted/multi-chunk evidence back to original indexed line coordinates and preserve applicable context provenance separately.
- Hard-delimit all retrieved/clipped text as untrusted data and include trust/egress placeholders without allowing content to alter compiler policy.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/chunk-lookup.ts`
- `src/core/sections.ts`
- `src/store/types.ts:130-170`
- `src/pipeline/hybrid.ts:804-840`

**Optional** (reference as needed):
- `src/core/document-capabilities.ts`
- `src/converters/canonicalize.ts`

## Acceptance
- [ ] Every evidence item round-trips to exact indexed source lines and hashes.
- [ ] Prompt-injection fixture text remains literal evidence and cannot alter selection, schema, or tool policy.
- [ ] Missing dates/headings degrade additively without losing mandatory source identity.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
