---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-110-file-and-export-first-source-adapters.5 Implement explicit browser export adapters

## Description
Deliver implement explicit browser export adapters as one implementation-sized increment.

**Size:** M
**Files:** `src/converters/adapters/browser-export/adapter.ts`, `src/converters/adapters/browser-export/formats.ts`, `test/converters/browser-export.test.ts`, `test/fixtures/exports/browser`

### Approach
- Support explicitly selected bookmark/history/reading-list export files through documented format detectors; never read live browser profiles/databases/cookies.
- Use export kind plus normalized URL/stable export ID as record identity, preserving title/folder/tags/visit/read dates and source locator.
- Sanitize embedded HTML, bound records/fields, and avoid fetching URLs, favicons, or remote metadata.

### Investigation targets
**Required** (read before coding):
- `src/converters/canonicalize.ts`
- `src/core/validation.ts`

**Optional** (reference as needed):
- `src/core/tags.ts`
- `src/ingestion/frontmatter.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/ingestion/record-adapter.ts`
- `src/core/browser-clip.ts`

## Acceptance
- [ ] Supported export fixtures produce deterministic records with URL/title/folder/tags/dates/provenance and stable identity.
- [ ] Live-profile paths, cookies, dangerous schemes, embedded executable HTML, remote fetches, and oversized exports are denied or bounded.
- [ ] Complete/partial re-import behavior matches the shared snapshot/tombstone contract.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
