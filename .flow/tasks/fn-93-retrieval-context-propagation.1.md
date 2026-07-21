---
satisfies: [R1, R4, R6]
---
# fn-93-retrieval-context-propagation.1 Build the canonical scoped-context resolver

## Description
Deliver build the canonical scoped-context resolver as one implementation-sized increment.

**Size:** M
**Files:** `src/core/context-resolver.ts`, `src/store/types.ts`, `src/store/sqlite/adapter.ts`, `test/core/context-resolver.test.ts`

### Approach
- Resolve global, collection, and segment-safe path-prefix scopes from one canonical document identity.
- Return ordered provenance records plus the backward-compatible joined text; collapse duplicates by normalized scope identity and byte-normalized text.
- Load contexts once per request/store generation and invalidate on context sync rather than querying per result.

### Investigation targets
**Required** (read before coding):
- `src/config/types.ts:128-165`
- `src/store/sqlite/adapter.ts:501-558`
- `src/core/indexed-reference.ts`

**Optional** (reference as needed):
- `test/store/adapter.test.ts:244-272`
- `src/core/validation.ts`

### Key context
- Use collection-relative normalized paths as the prefix-match authority; converter source locators are provenance, not scope identity.
- Context provenance is required by fn-98 even though public SearchResult keeps the joined optional string.

## Acceptance
- [ ] Resolver tests cover global/collection/nested prefix order, segment boundaries, slash normalization, duplicate collapse, and no-match behavior.
- [ ] One request/store snapshot performs at most one context-table read for any result count.
- [ ] A context sync invalidates the cached generation without stale reads or retrieval failure.


## Done summary
Added a canonical scoped-context resolver with deterministic global, collection, and segment-safe prefix precedence, normalized duplicate collapse, and ordered provenance. Added store-generation invalidation so one request-local resolver reads contexts once per generation and refreshes safely after sync.
## Evidence
- Commits: 3a857be52358384b9b575bca0815921f108bd8a8
- Tests: bun test test/core/context-resolver.test.ts test/store/adapter.test.ts, bun test test/pipeline test/store/adapter.test.ts, bun run lint:check, .flow/bin/flowctl validate --spec fn-93-retrieval-context-propagation --json
- PRs: