# fn-66-collection-level-model-editor-in-web-ui.2 Build collection-level model editor UX in the web app

## Description
Build the user-facing collection model editor once the API exists.

Start here:

- `src/serve/public/pages/Collections.tsx`
- `src/serve/public/components/`
- `src/serve/public/hooks/use-api.ts`
- `docs/WEB-UI.md`

UX goals:

- entry point lives with collection management
- users can inspect effective values before editing
- inherited vs overridden state is obvious at a glance
- reset-to-inherit action is first-class
- embed override changes warn about follow-up re-embedding work

Recommended UI shape:

- new dropdown action on collection cards:
  - `Model settings`
- dialog or sheet with one row per role:
  - `embed`
  - `rerank`
  - `expand`
  - `gen`
- each row shows:
  - effective URI
  - source badge (`Preset` / `Override`)
  - editable override input
  - clear/reset control
- save/cancel state should be explicit and resilient to reload failures

Also cover:

- loading / saving / inline error states
- invalid URI validation messaging from API
- success feedback after save
- visible note when changed embed override means semantic results depend on new embeddings for that collection

Do not do in this task:

- path/file-type override UI
- global preset picker redesign
- benchmark surfacing beyond a small explanatory link if useful

Tests:

- component tests for editor open/edit/reset/save states if existing frontend test setup supports them
- route/integration coverage for happy path and validation errors
- manual smoke notes for:
  - save override
  - clear override
  - reload page and confirm persistence
  - switch active preset and confirm inherited rows update

## Acceptance
- [ ] The Collections page exposes a collection-level model editor.
- [ ] Users can set, update, and clear overrides for individual roles.
- [ ] The UI shows effective model URIs and inheritance source clearly.
- [ ] The UI warns when embed override changes imply re-embedding work.
- [ ] Save/load/error states are handled without forcing manual config edits.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
