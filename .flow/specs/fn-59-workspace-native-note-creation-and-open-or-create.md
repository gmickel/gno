# fn-59-workspace-native-note-creation-and-open-or-create Workspace-native note creation and open-or-create flows

## Overview

Make note creation feel native to the workspace instead of hidden behind one capture modal.

Users and agents should be able to create notes from the current place they are working:

- current folder in Browse
- current collection
- quick switcher / command surface
- wiki-link create flow
- doc-to-doc related workflows

This is the first "Obsidian replacement" epic that shifts GNO from "great place to find notes" to "real place to make notes."

## Prior Context

- `fn-41-document-workspace-foundation-for` established safe document creation/editing boundaries and the editable-copy model for read-only source docs.
- `fn-45-desktop-beta-workspace-navigation` established recents, favorites, and quick-switcher behavior.
- `fn-53-desktop-beta-app-level-tabs-and-multi` established tab-scoped workspace context.
- `fn-58-cross-collection-tree-browse-workspace` established place-aware navigation and current-folder context.
- `docs/adr/001-scholarly-dusk-design-system.md` is the canonical UI/UX reference for all `gno serve` workspace work.
- Today GNO can create notes, but it still feels modal-first and global, not place-first and workspace-native.

## Why now

- This is the clearest remaining gap between "search workspace" and "daily driver note workspace."
- Browse/tree now exists, so creation can be path-aware instead of collection-dropdown-only.
- Agents need the same create/open resolution rules humans use; otherwise the app and agent surfaces drift apart.

## Difficulty

Medium.

## Start Here

- `src/serve/public/components/CaptureModal.tsx`
- `src/serve/public/components/QuickSwitcher.tsx`
- `src/serve/public/pages/Browse.tsx`
- `src/serve/public/pages/DocView.tsx`
- `src/serve/public/lib/workspace-tabs.ts`
- `src/serve/routes/api.ts`
- `docs/WEB-UI.md`
- `docs/API.md`
- `docs/MCP.md`
- `docs/adr/001-scholarly-dusk-design-system.md`

## Scope

- create note from current browse folder
- create note from current collection root
- quick-switcher "open or create" flow
- stronger wiki-link create flow with explicit target path/collection rules
- note path/name suggestion from current context
- create note API that accepts target folder context explicitly
- shared creation contract so UI / CLI / SDK / MCP can all expose the same semantics
- docs, website, and tests

## Explicit Non-goals

- daily notes
- generic templates library
- slash commands
- folder creation
- drag/drop or bulk file operations

## Product Stance

- Creation should be place-aware, not just title-aware.
- "Open or create" should be deterministic and explainable.
- Humans and agents should hit the same path resolution rules.
- Avoid magic location rules that depend on hidden UI state only.
- Any new UI affordances must follow the Scholarly Dusk design system instead of introducing a parallel visual language.

## Requirements

- Users can create a note directly from the selected folder in Browse.
- Users can create a note directly from the selected collection when no folder is selected.
- Quick-switcher supports a strong "open existing or create here" path.
- Wiki-link create flow can target the current collection/folder by default and show that choice clearly.
- Note creation contract resolves:
  - collection
  - folder path
  - title
  - slug/file name
  - collision policy
- Collision policy is explicit:
  - open existing
  - disambiguate
  - or create with suffix
- API/operation contract defines parity across all applicable surfaces:
  - Web UI
  - CLI
  - SDK
  - MCP
- applicable surfaces must share:
  - path resolution
  - validation
  - collision behavior
  - result semantics

## UX Deliverables

- create-note affordance in Browse detail pane
- create-note affordance at collection root level
- improved quick-switcher action row:
  - open exact
  - create note
  - open-or-create
- clear location hint before creation
- clear duplicate-name handling
- creation affordances and action rows that match the Scholarly Dusk rail/button/panel vocabulary

## Technical Deliverables

- central note-creation service / resolver
- API endpoint(s) for place-aware note creation
- typed result shape for:
  - created note
  - existing note opened instead
  - collision/disambiguation result
- tests for:
  - path resolution
  - collision behavior
  - browse-scoped creation
  - quick-switcher create/open-or-create behavior
- docs updates in `docs/`
- website updates where note-creation claims or workspace flows are described

## Architecture Rule

Do not bury creation rules only inside React components.

Create one shared creation contract that guarantees parity across:

- Web UI
- CLI
- SDK
- MCP tool(s)
- agent skills via CLI wrappers

## Risks / Design Traps

- hidden default path behavior that surprises users
- duplicate note creation due to fuzzy matching ambiguity
- wiki-link create semantics drifting from general note-create semantics
- building a modal soup instead of one coherent create/open contract

## Quick commands

- `bun run lint:check`
- `bun test`
- `bun run test:e2e`

## Acceptance

- [ ] Create note works from current folder and current collection, not only a global modal.
- [ ] Quick-switcher supports a real open-or-create flow.
- [ ] Wiki-link create flow follows the same core path-resolution contract.
- [ ] Shared creation semantics exist outside UI-only code.
- [ ] New UI follows `docs/adr/001-scholarly-dusk-design-system.md`.
- [ ] Docs in `docs/`, website copy/pages, and tests all reflect the new note-creation model.
