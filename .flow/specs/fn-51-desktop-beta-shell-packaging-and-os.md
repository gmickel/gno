# Desktop Beta: Shell Packaging and OS Integration

## Overview

Package GNO as a real desktop app with file associations, single-instance behavior, app protocol/deep links, and managed service startup.

## Prior Context

- `fn-41-document-workspace-foundation-for` is already complete. That means GNO now has: read-only converted-document handling, editable markdown copies, optimistic save conflicts, local editor snapshots, deep links with line targets, live document-refresh plumbing, wiki-link autocomplete, and a fast Cmd/Ctrl+K quick switcher.
- The larger goal is not just “native app”, but “usable for Gordon's team and normies”: install easily, connect agents easily, understand what is happening, and trust the product without using the terminal.
- `docs/` is the source of truth for product behavior and architecture decisions. If behavior changes, update docs and website in the same implementation.
- Until the explicit runtime evaluation epic, keep implementation stack-agnostic. Do not prematurely lock the product to Tauri/Electron/Electrobun-specific assumptions outside the runtime/shell epics.

## Difficulty

Hard.

## Why now

This is the first truly normie-visible desktop milestone, but it should only land after the service/runtime decisions are settled.

## Start Here

- chosen runtime decision from `fn-50`
- runtime/model bootstrap decisions from `fn-49`
- `src/serve/server.ts`
- `src/serve/public/app.tsx`
- deep-link helpers and watch service already in product

## Dependencies

- Blocked by: `fn-49-desktop-beta-runtime-and-model-bootstrap`, `fn-50-desktop-beta-native-runtime-evaluation`
- Unblocks: `fn-52`
- This epic is the first true desktop-shell implementation milestone.

## Constraints Already Decided

- Preserve the workspace semantics already shipped in web form; the shell should wrap them, not fork them.
- File/open/deep-link behavior must land on the same document/deep-link routes already used in `fn-41`.
- Service startup/shutdown behavior must align with the reliability expectations hardened in `fn-48`.

## Scope

- native shell wrapper
- service startup/shutdown management
- file associations for markdown/plaintext
- single-instance handoff
- deep-link/app protocol integration
- docs for install/open-file behavior

## Explicit Non-goals

- signing/notarization/updater work
- org rollout process

## Required Deliverables

- Working packaged shell for the chosen runtime
- Open-file, app-protocol, and single-instance handoff flows
- Updated install/open-file docs
- End-to-end verification for launch/open/deep-link behavior on target OSes

## Acceptance

- Users can install and open GNO like a normal desktop app.
- Opening an associated file or deep link routes into the existing workspace cleanly.
