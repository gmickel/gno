# fn-46-desktop-beta-file-lifecycle-and-finder.1 Add rename, trash, and reveal flows for local files

## Description

Build the first file-lifecycle slice on top of the existing workspace safety model.

Initial slice:

- add API support for rename, reveal, and trash flows for editable/local files
- expose those actions in DocView and/or Browse with plain-language on-disk/index semantics
- keep converted read-only docs out of unsupported mutation paths
- prefer reversible trash behavior and explicit copy around what remains in the index vs on disk
- add regression coverage for file-operation safety paths and docs updates

## Acceptance

- [ ] Users can rename and trash supported local files from the app with clear semantics
- [ ] Reveal/open-folder affordances exist for supported local files
- [ ] Unsupported/read-only docs show honest restrictions instead of broken actions

## Done summary
Shipped the first file lifecycle and Finder integration slice.

Highlights:
- added backend rename, reveal, and trash flows for supported editable/local files
- kept read-only converted docs out of unsupported mutation paths
- updated DocView with Rename, Reveal, and Trash/Remove semantics based on actual file capability
- updated docs to distinguish Move to Trash vs Remove from index behavior
- added regression coverage for rename/trash/reveal safety paths
- verified in-browser that editable docs now expose the new file lifecycle actions
## Evidence
- Commits:
- Tests: bun test test/serve/api-docs-lifecycle.test.ts, bun run lint:check, bun run typecheck, bun test, bun run docs:verify, browser sanity: agent-browser open editable doc view on http://localhost:3130; Rename/Reveal/Trash actions visible
- PRs: