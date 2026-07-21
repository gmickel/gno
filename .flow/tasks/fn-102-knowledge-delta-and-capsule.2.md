---
satisfies: [R1, R5, R7]
---
# fn-102-knowledge-delta-and-capsule.2 Compute source heading link and typed-edge deltas during sync

## Description
Deliver compute source heading link and typed-edge deltas during sync as one implementation-sized increment.

**Size:** M
**Files:** `src/ingestion/sync.ts`, `src/core/change-diff.ts`, `src/core/sections.ts`, `src/core/links.ts`, `test/ingestion/change-delta.test.ts`

### Approach
- Capture pre/post canonical document metadata inside the sync transaction and derive bounded heading, link, typed relationship, date, and content-hash additions/removals.
- Coalesce watcher/full-sync races into one logical sequence keyed by stable document generation.
- Store structural summaries and hashes, not unbounded old document bodies; return history-unavailable when retention prevents reconstruction.

### Investigation targets
**Required** (read before coding):
- `src/ingestion/sync.ts:1008-1080`
- `src/ingestion/sync.ts:1557-1620`
- `src/core/sections.ts`
- `src/core/links.ts`
- `src/core/graph-resolver.ts`

**Optional** (reference as needed):
- `src/serve/watch-service.ts`
## Acceptance
- [ ] Fixtures produce exact added/removed headings, links, typed edges, and hash transitions.
- [ ] Concurrent watcher/full sync settles to one logical delta sequence.
- [ ] Large changes truncate with disclosure and never retain unrestricted source bodies.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
