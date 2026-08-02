---
satisfies: [R4]
---

# fn-61-document-structure-navigation-and-section-addressability.6 Expose section target creation and resolution through REST and SDK
## Description
Expose section target creation and resolution through REST and SDK. Both adapters consume the shared core resolver, preserve current section-list behavior, and return the same status/citation evidence without parser duplication.

**Size:** M
**Files:** `src/serve/routes/api.ts`, `src/serve/server.ts`, `src/sdk/client.ts`, `src/sdk/types.ts`, `spec/output-schemas/`, `test/serve/`, `test/sdk/client.test.ts`

## Approach
- Extend existing sections/document contracts compatibly and deliberately version new fields/endpoints.
- Return canonical URI, current anchor, line range, fingerprint, and exact/recovered/non-success status.
- Reuse one fixture matrix across REST and SDK.

## Investigation targets
**Required** (read before coding):
- `src/serve/routes/api.ts:1919-1948` — current sections endpoint
- `src/serve/server.ts:1162-1173` — route registration
- `src/sdk/client.ts:1832-1836` — SDK `getSections()`
- `src/sdk/types.ts:347` — public SDK section contract
- `test/sdk/client.test.ts:583-635` — SDK section/file-operation patterns

**Optional** (reference as needed):
- `docs/API.md:65` — current endpoint documentation
- `test/core/sections.test.ts` — shared fixture source

## Key context
Existing `/api/doc/:id/sections` and SDK `getSections()` stay backward compatible. Ambiguous/stale/missing resolution is explicit and non-navigable by default.

## Acceptance
- [ ] REST and SDK accept/return the versioned target without duplicating extraction/resolution logic.
- [ ] Exact/recovered results include canonical URI, anchor, line range, fingerprint, and status; ambiguous/stale/missing preserve diagnostics.
- [ ] Current sections endpoint and SDK `getSections()` remain backward compatible.
- [ ] Shared fixtures prove schema and semantic parity across REST/SDK.
- [ ] Focused API/SDK tests, specs/docs, and lint pass.
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
