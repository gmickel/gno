# fn-59-workspace-native-note-creation-and-open-or-create.2 Add browse-scoped create note actions for collection and folder context

## Description

Use the shared creation contract in the workspace itself.

Initial slice:

- add create-note actions from selected collection root and selected folder
- show target path/location clearly before creation
- keep the UI inside the Scholarly Dusk system
- preserve tab-scoped browse context after creation
- add DOM coverage for browse-scoped creation flows

## Acceptance

- [ ] Users can create notes directly from current collection or current folder
- [ ] Target location is visible and understandable before create
- [ ] New UI follows the Scholarly Dusk ADR
- [ ] Browse state remains coherent after note creation
- [ ] Tests cover browse-scoped create flows

## Done summary

## Evidence

- Commits:
- Tests:
- PRs:

