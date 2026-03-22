# Desktop Beta: File Lifecycle and Finder Integration

## Overview

Finish the core day-to-day file operations needed for normie use: rename, move, trash, reveal in Finder, and clear affordances for what happens on disk vs in the index.

## Prior Context

- `fn-41-document-workspace-foundation-for` is already complete. That means GNO now has: read-only converted-document handling, editable markdown copies, optimistic save conflicts, local editor snapshots, deep links with line targets, live document-refresh plumbing, wiki-link autocomplete, and a fast Cmd/Ctrl+K quick switcher.
- The larger goal is not just “native app”, but “usable for Gordon's team and normies”: install easily, connect agents easily, understand what is happening, and trust the product without using the terminal.
- `docs/` is the source of truth for product behavior and architecture decisions. If behavior changes, update docs and website in the same implementation.
- Until the explicit runtime evaluation epic, keep implementation stack-agnostic. Do not prematurely lock the product to Tauri/Electron/Electrobun-specific assumptions outside the runtime/shell epics.

## Difficulty

Medium.

## Why now

Normie trust depends on understanding file ownership and basic operations, especially once GNO becomes more editor-like.

## Start Here

- `src/serve/public/pages/DocView.tsx`
- `src/serve/public/pages/Browse.tsx`
- `src/serve/routes/api.ts`
- `src/core/file-ops.ts`
- existing `fn-28` epic for delete-from-web-ui context

## Dependencies

- Blocked by: `fn-41-document-workspace-foundation-for`, `fn-45-desktop-beta-workspace-navigation`
- Unblocks: `fn-47`
- This epic should build on the file capability/write-safety work already shipped in `fn-41`.

## Constraints Already Decided

- Converted docs stay read-only; file lifecycle actions must respect that contract.
- Destructive actions should prefer reversible flows (`trash`) over hard deletes where possible.
- UI copy must make the distinction between file-system state and index state explicit.

## Scope

- rename documents
- move between folders/collections where appropriate
- trash/remove flows with recovery semantics
- reveal in Finder / open containing folder
- explain index vs file-system behavior clearly in UI/docs

## Explicit Non-goals

- Native shell file associations
- background service/runtime packaging

## Required Deliverables

- API + UI support for rename/move/trash/reveal flows
- Safety affordances and recovery semantics
- Updated docs/website copy for file ownership and deletion behavior
- Regression coverage for file-operation edge cases

## Acceptance

- Users can perform normal file operations without dropping to Finder/terminal.
- Destructive actions are reversible or clearly explained.
