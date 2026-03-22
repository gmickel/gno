# Desktop Beta: App-Level Tabs and Multi-Editor Workspace

## Overview

Build an Obsidian-like multi-document workspace inside GNO itself: persistent tabs for docs/search/browse/ask, predictable “open in new tab” behavior, and at least one simultaneous multi-editor / split-pane workflow so users can work across several notes at once.

## Prior Context

- `fn-41-document-workspace-foundation-for` is already complete. That means GNO now has: read-only converted-document handling, editable markdown copies, optimistic save conflicts, local editor snapshots, deep links with line targets, live document-refresh plumbing, wiki-link autocomplete, and a fast Cmd/Ctrl+K quick switcher.
- The larger goal is not just “native app”, but “usable for Gordon's team and normies”: install easily, connect agents easily, understand what is happening, and trust the product without using the terminal.
- `docs/` is the source of truth for product behavior and architecture decisions. If behavior changes, update docs and website in the same implementation.
- Electrobun is the shell direction for the desktop beta, but tabs should live in the GNO app layer, not in Electrobun's native BrowserView tab model.

## Difficulty

Medium to hard.

## Why now

For GNO to replace Obsidian day-to-day, users need more than navigation polish. They need several docs open, fast switching, and at least one side-by-side editing/viewing workflow.

## Start Here

- `src/serve/public/app.tsx`
- `src/serve/public/pages/DocumentEditor.tsx`
- `src/serve/public/pages/DocView.tsx`
- `src/serve/public/pages/Search.tsx`
- `src/serve/public/pages/Browse.tsx`
- `src/serve/public/pages/Ask.tsx`
- `src/serve/public/lib/deep-links.ts`
- `src/serve/public/lib/local-history.ts`
- `desktop/electrobun-spike/`
- `plans/electrobun-spike.md`

## Dependencies

- Blocked by: `fn-41-document-workspace-foundation-for`, `fn-45-desktop-beta-workspace-navigation`
- Shell/open-file work from `fn-51` should target this tab model once it exists.

## Constraints Already Decided

- Tabs are app-level state in the existing React workspace.
- Do not implement native Electrobun BrowserView tabs as GNO's document model.
- Tabs must preserve `fn-41` guarantees: deep links, optimistic save conflicts, local history, and read-only converted-doc rules.
- Open-file and deep-link events should be able to choose between reuse-current-tab and open-new-tab without inventing a second navigation system.

## Scope

- app-level tabs for docs, search, browse, ask, and graph
- open in new tab / duplicate tab / close tab / restore tab behavior
- dirty-state and unsaved-change affordances
- session restore for recent tabs/workspace layout
- at least one split-pane / simultaneous multi-editor workflow
- docs/website updates for the new workspace model

## Explicit Non-goals

- native BrowserView tab implementation
- multi-window OS shell management
- shell packaging itself
- file-system operations like rename/move/trash

## Required Deliverables

- persistent tab state model
- tab strip / tab commands / open-in-new-tab flows
- one split-pane or dual-editor workflow
- deep-link/open-file integration hooks for shell work
- docs/website updates and tests around state restoration / dirty state where practical

## Acceptance

- Users can keep multiple notes and searches open simultaneously in GNO.
- Users can work with at least two documents/editors visible in the same session without awkward workarounds.
- Deep links and shell open-file events can target the tab workspace predictably.
