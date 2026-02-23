# fn-30-ask-query-mode-parity-in-webapi Ask query mode parity in Web/API

## Overview

Expose structured `queryModes` in Ask end-to-end so power users can steer retrieval semantics in Q&A, matching Query route capabilities.

## Scope

- Add `queryModes` request support to `POST /api/ask`.
- Validate `queryModes` with same contract as `POST /api/query`:
  - allowed modes: `term`, `intent`, `hyde`
  - non-empty `text`
  - max one `hyde` entry
- Pass validated `queryModes` into `searchHybrid` from Ask handler.
- Add Ask UI controls for `queryModes` (add/remove chips) in advanced retrieval panel.
- Include `queryModes` in Ask request body when set.
- Add/extend tests for API validation + pass-through and UI helper behavior.
- Update user docs/spec docs for Ask request shape and web UX.

## Approach

1. API contract:
   - Extend `AskRequestBody` in `/src/serve/routes/api.ts` with `queryModes?: QueryModeInput[]`.
   - Reuse query-mode validation branch from `handleQuery` (extract helper if useful).
   - Wire `queryModes` into `searchHybrid` options in `handleAsk`.
2. Web UI:
   - Add query-mode builder section in `/src/serve/public/pages/Ask.tsx`.
   - Reuse shared filter/query-mode parsing helpers from `/src/serve/public/lib/retrieval-filters.ts`.
   - Keep UX parity with Search page (single-hyde guard, removable chips, clear errors).
3. Tests:
   - Add Ask API tests for valid/invalid `queryModes`.
   - Ensure regression coverage for duplicate `hyde` rejection.
4. Docs/spec:
   - Update `/docs/API.md`, `/docs/WEB-UI.md`, and `/spec/output-schemas/*` only if output shape changes.

## Quick commands

<!-- Required: at least one smoke command for the repo -->

- `bun run lint:check`
- `bun test test/serve/api-ask.test.ts test/mcp/tools/query.test.ts`
- `bun test`
- `bun run docs:verify`

## Acceptance

- [ ] `POST /api/ask` accepts valid `queryModes` and rejects invalid payloads with `VALIDATION` errors.
- [ ] Ask handler forwards `queryModes` to hybrid retrieval and behavior is observable in responses.
- [ ] Ask page exposes query-mode controls usable on desktop and mobile widths.
- [ ] Query-mode UI prevents duplicate `hyde` entries and allows chip removal.
- [ ] Tests cover happy path + validation failures.
- [ ] Docs updated to reflect Ask query-mode capability.

## References

- `/src/serve/routes/api.ts`
- `/src/serve/public/pages/Ask.tsx`
- `/src/serve/public/lib/retrieval-filters.ts`
- `/docs/API.md`
- `/docs/WEB-UI.md`
