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
Pending implementation.

## Evidence
- Commits:
- Tests:
- PRs:
