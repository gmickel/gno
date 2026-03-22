# fn-44-desktop-beta-import-and-migration.1 Add import preview assistant for existing folders

## Description

Build the first import assistant slice inside the existing web app.

Initial slice:

- add an import preview flow for existing note/doc folders before indexing starts
- detect Obsidian-style vault signals and mixed-folder characteristics
- surface plain-language guidance for notes vs binary archives vs mixed work docs
- block obvious duplicate path/collection imports with clear next actions
- update migration/docs/comparison copy to match the real import flow

## Acceptance

- [ ] Users can preview what GNO will import before starting indexing
- [ ] Obsidian-style folders get tailored guidance instead of generic copy
- [ ] Duplicate path/collection conflicts are explained clearly in the import flow

## Done summary

Shipped the first import/migration assistant slice.

Highlights:

- added duplicate-path validation to collection creation
- added `/api/import/preview` with Obsidian-vault and mixed-folder detection, file-type counts, guidance, and conflict reporting
- surfaced the preview inside the add-collection dialog before indexing starts
- updated Obsidian/use-case/FAQ migration copy to match the real preview flow
- verified the dialog in-browser with a real Obsidian-style folder preview

## Evidence

- Commits:
- Tests: bun test test/serve/api-collections.test.ts, bun run lint:check, bun run typecheck, bun test, bun run docs:verify, browser sanity: agent-browser open http://localhost:3127/collections; add collection dialog preview verified for GordonsVault
- PRs:
