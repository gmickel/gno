---
satisfies: [R1, R4, R5]
---
# fn-108-explainable-content-type-search-boosts.1 Normalize bound and fingerprint searchBoost configuration

## Description
Deliver normalize bound and fingerprint searchboost configuration as one implementation-sized increment.

**Size:** M
**Files:** `src/config/types.ts`, `src/config/content-types.ts`, `src/config/defaults.ts`, `test/config/content-types.test.ts`

### Approach
- Define the public contract: neutral `1.0`, accepted finite range `0.5..2.0`, and one canonical configured value per resolved content type.
- Include searchBoost in normalized content-type fingerprints and config warnings/errors; unchanged configs remain neutral and fingerprint-compatible except where rule semantics genuinely changed.
- Resolve canonical content type through the existing frontmatter/prefix rules; boosts never stack or derive from arbitrary category text.

### Investigation targets
**Required** (read before coding):
- `src/config/types.ts:262-277`
- `src/config/content-types.ts:51-140`
- `src/ingestion/frontmatter.ts`
- `src/store/migrations/009-content-type-rule-fingerprint.ts`

**Optional** (reference as needed):
- `test/config/content-types.test.ts`
- `docs/CONFIGURATION.md:331-360`

### Key context
- The input range is configuration expressiveness; ranking impact is separately capped to a maximum absolute normalized contribution of 0.05.

## Acceptance
- [ ] Finite in-range values normalize deterministically; neutral/missing remains 1.0; invalid values produce stable diagnostics.
- [ ] Fingerprint changes when effective boost semantics change and remains stable for equivalent normalized rules.
- [ ] Longest-prefix/canonical type resolution yields one non-stacking effective boost.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
