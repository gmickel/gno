# fn-82-second-brain-capture-and-provenance.3 Add REST and SDK capture parity

## Description

Expose capture-with-provenance through REST/API and SDK while preserving raw note creation as a distinct lower-level surface.

This task should add `POST /api/capture` or an explicitly documented equivalent route that delegates to the shared core. It should add `client.capture(input)` unless the implementation proves the existing `createNote()` can expose capture semantics cleanly without mixing raw note creation and provenance capture concepts.

Expected files:
- `src/serve/server.ts`
- `src/serve/routes/api.ts`
- `src/sdk/client.ts`
- `src/sdk/types.ts`
- `docs/API.md`
- `docs/SDK.md`
- `README.md`
- `assets/skill/SKILL.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`
- `test/serve/*capture*.test.ts` or adjacent API lifecycle tests
- `test/sdk/client.test.ts`

Design decisions:
- `POST /api/docs` remains raw note creation.
- Capture route/method returns the shared receipt and states capture write, sync/FTS ingestion, and embed/vector indexing separately.
- API may remain async through existing job behavior; SDK can remain synchronous if it directly writes and syncs. Receipt fields must make differences explicit.
- If fallback API routing remains supported, `/api/capture` must be registered there as well as in the primary server route table.

## Acceptance

- [ ] **R1:** REST capture accepts the shared input contract, applies existing CSRF/token behavior, and delegates to the shared capture core.
- [ ] **R2:** SDK exposes a typed capture method or equivalent that returns the shared receipt without weakening `createNote()` as raw note creation.
- [ ] **R3:** API receipts accurately report file-write, sync/FTS job, and embed states, including busy/deferred sync cases and optional docid before sync completion.
- [ ] **R4:** API route tests cover primary route and fallback API router if both remain supported.
- [ ] **R5:** REST/SDK tests cover provenance, default UTC path, collision policies, missing/non-editable collection errors, disk-only collisions, and schema-compatible receipts.
- [ ] **R6:** `docs/API.md`, `docs/SDK.md`, README, skill docs, and hosted `gno.sh` API/SDK docs distinguish capture-with-provenance from raw note creation and editable copy, reusing canonical task-1 schema/status wording.

## Done summary

## Evidence

- Commits:
- Tests:
- PRs:
