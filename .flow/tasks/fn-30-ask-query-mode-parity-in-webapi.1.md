# fn-30-ask-query-mode-parity-in-webapi.1 Wire queryModes through Ask API and Ask page

## Description

Implement Ask parity for structured query modes. Add API validation + pass-through, Ask page controls, and coverage/docs so advanced retrieval steering is available during Q&A, not only search.

## Acceptance

- [ ] `AskRequestBody` supports `queryModes` in `/src/serve/routes/api.ts`.
- [ ] Ask endpoint validates `queryModes` exactly like Query endpoint (`term|intent|hyde`, non-empty text, single `hyde`).
- [ ] Ask endpoint passes `queryModes` into `searchHybrid`.
- [ ] Ask page advanced retrieval panel supports add/remove query-mode chips.
- [ ] Ask page blocks duplicate `hyde` locally with inline error feedback.
- [ ] Tests added/updated for API and UI helper logic.
- [ ] Docs updated (`/docs/API.md`, `/docs/WEB-UI.md`).

## Done summary
Implemented Ask-side structured query mode parity. The Ask API now validates and forwards `queryModes` exactly like Query, the Ask page exposes add/remove query-mode chips with duplicate-HyDE guardrails, and Ask responses surface the query-mode summary metadata.
## Evidence
- Commits:
- Tests: bun run lint:check, bun test, curl -sS -X POST http://127.0.0.1:3316/api/ask ... valid queryModes, curl -sS -X POST http://127.0.0.1:3316/api/ask ... duplicate hyde
- PRs: