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
Defined the bounded content-type search-boost contract and made it part of normalized rule identity.

Key outcomes:
- Search boosts accept only finite values from 0.5 through 2.0 and normalize omitted values to neutral 1.0.
- Omitted and explicit-neutral boosts retain the legacy content-type fingerprint; non-neutral semantic changes invalidate the fingerprint deterministically.
- One shared resolver selects an exact configured type before longest-prefix fallback, never stacks rules, and ignores arbitrary category text.
- Main config and project-profile Zod/Draft-07 validation enforce the same numeric range.
- Existing ingestion now uses the shared canonical rule resolver.
## Evidence
- Commits:
- Tests: bun run lint:check (0 errors), bun test focused content-type/profile/ingestion/graph/diagnose suite (124 passed, 0 failed), git diff --check
- PRs: