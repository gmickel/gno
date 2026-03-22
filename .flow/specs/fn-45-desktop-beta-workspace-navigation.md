# Desktop Beta: Workspace Navigation, Recents, and Favorites

## Overview

Turn the current workspace into something people can live in all day: recent docs, favorites, pinned collections, and a more complete quick-switcher/navigation story.

## Prior Context

- `fn-41-document-workspace-foundation-for` is already complete. That means GNO now has: read-only converted-document handling, editable markdown copies, optimistic save conflicts, local editor snapshots, deep links with line targets, live document-refresh plumbing, wiki-link autocomplete, and a fast Cmd/Ctrl+K quick switcher.
- The larger goal is not just “native app”, but “usable for Gordon's team and normies”: install easily, connect agents easily, understand what is happening, and trust the product without using the terminal.
- `docs/` is the source of truth for product behavior and architecture decisions. If behavior changes, update docs and website in the same implementation.
- Until the explicit runtime evaluation epic, keep implementation stack-agnostic. Do not prematurely lock the product to Tauri/Electron/Electrobun-specific assumptions outside the runtime/shell epics.

## Difficulty

Medium.

## Why now

Navigation polish compounds the value of the new workspace foundation, helps users stop bouncing back to other note apps, and sets up the later multi-document tab workspace.

## Start Here

- `src/serve/public/components/QuickSwitcher.tsx`
- `src/serve/public/app.tsx`
- `src/serve/public/pages/Dashboard.tsx`
- `src/serve/public/pages/Browse.tsx`
- `website/index.md`
- `website/features/web-ui.md`

## Dependencies

- Blocked by: `fn-41-document-workspace-foundation-for`, `fn-42-desktop-beta-onboarding-and-health`
- Unblocks: `fn-46`, `fn-53`
- This epic should extend the shipped quick-switcher/navigation foundation from `fn-41`, not replace it.

## Constraints Already Decided

- Cmd/Ctrl+K already exists from `fn-41`; this epic is polish/expansion, not a greenfield palette rewrite.
- Navigation should help users stay in GNO all day without bouncing to Finder/Obsidian.
- Keep behavior stack-agnostic so the same navigation model can survive a later native shell.
- Full multi-document tabs and simultaneous editors live in `fn-53`, not here.

## Scope

- recent documents surfaces beyond Cmd/Ctrl+K
- favorites / pinned collections / pinned docs
- landing-page navigation polish
- quick-switcher result grouping and behavior polish
- docs/website updates for the navigation story

## Explicit Non-goals

- full tabbed multi-document workspace
- split editors / multi-pane editing
- file-system operations like rename/move/trash
- shell packaging

## Required Deliverables

- Persistent recents/favorites/pins model
- UI surfaces that expose those shortcuts outside the hidden keyboard shortcut
- Docs/website updates describing the new navigation model
- Tests around persistence/state restoration where practical

## Acceptance

- Users can reliably get back to the notes and collections they use most.
- Quick-switcher feels like a primary navigation surface, not just a hidden shortcut.
- Navigation model sets up a later tabbed workspace cleanly instead of fighting it.
