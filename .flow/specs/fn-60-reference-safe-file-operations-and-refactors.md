# fn-60-reference-safe-file-operations-and-refactors Reference-safe file operations and note refactors

## Overview

Add first-class file operations for editable notes without breaking the graph of references around them.

This epic is about making rename/move/duplicate/new-folder operations feel safe and trustworthy. It should improve workspace ownership without introducing silent backlink damage or path drift.

## Prior Context

- Current file lifecycle already distinguishes editable local files from read-only converted source material.
- Editable docs can already be renamed/revealed/trashed in some surfaces.
- Browse/tree now gives the app enough folder context to support serious file operations.
- GNO already extracts wiki links, markdown links, backlinks, and related notes. File refactors have to respect those realities.

## Why now

- Obsidian replacement status requires stronger organization, not just stronger search.
- Once users start creating notes in-place, they immediately need to rename, move, and clean up.
- File ops without reference safety will destroy trust.

## Difficulty

Hard.

## Start Here

- `src/serve/public/pages/DocView.tsx`
- `src/serve/public/pages/Browse.tsx`
- `src/serve/routes/api.ts`
- `src/store/sqlite/adapter.ts`
- `src/ingestion/*`
- `docs/WEB-UI.md`
- `docs/API.md`

## Scope

- rename editable notes
- move editable notes between folders in a collection
- duplicate editable notes
- create folder
- reference-aware refactor planning
- reindex/update semantics after file operations
- user-facing preview/warning when references may change
- shared refactor engine with parity across applicable surfaces
- docs, website, tests

## Explicit Non-goals

- editing read-only source formats in place
- drag/drop reordering as first pass
- bulk multi-select file ops
- automatic rewrite of every possible arbitrary markdown path edge case without visibility

## Product Stance

- File ops should be safe by default, not clever by default.
- Backlinks and outgoing links are product features; file ops must preserve them where possible.
- If a refactor cannot be made safe, the app should say so explicitly.

## Requirements

- Rename editable note from workspace surfaces.
- Move editable note to another folder in the same collection in first pass.
- Duplicate note with explicit naming behavior.
- Create folder from Browse.
- Refactor engine produces a plan:
  - source path
  - target path
  - affected documents
  - rewriteable references
  - unresolved references / warnings
- For wiki links:
  - preserve identity if possible
  - prefer title/path resolution behavior that keeps backlinks intact
- For markdown links:
  - rewrite relative paths when safe
- Reindex/document refresh happens automatically after file ops complete.

## UX Deliverables

- rename dialog
- move dialog / destination picker
- duplicate action
- create-folder action
- refactor preview/warnings
- success confirmation with updated location

## Technical Deliverables

- shared file-op/refactor service
- path + link rewrite planner
- result schema shared across UI / CLI / SDK / MCP where the operation is exposed
- tests for:
  - rename preserving links
  - move preserving relative markdown links where possible
  - duplicate semantics
  - create-folder behavior
  - read-only doc refusal
- docs + website updates

## Architecture Rule

File operations cannot live only in component handlers.

Create one refactor layer that guarantees parity across:

- Web UI
- CLI commands
- SDK helpers
- MCP write tools when enabled

Matching surfaces must share:

- validation
- preview/warning behavior
- rewrite planning semantics
- success/error result shapes

## Risks / Design Traps

- silent link breakage
- mismatch between disk path and indexed identity
- cross-collection move complexity too early
- over-promising automatic rewrites beyond what the parser can prove

## Quick commands

- `bun run lint:check`
- `bun test`
- `bun run test:e2e`

## Acceptance

- [ ] Editable notes support rename, move, duplicate, and folder creation from workspace surfaces.
- [ ] File operations preserve or explicitly warn on affected references/backlinks.
- [ ] Read-only source files remain protected.
- [ ] File-op semantics live in a reusable refactor layer, not only in the UI.
- [ ] Docs, website, and tests reflect the new organization/file-op model.
