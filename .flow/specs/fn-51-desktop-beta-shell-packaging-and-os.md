# Desktop Beta: Shell Packaging and OS Integration

## Overview

Package GNO as a real desktop app on top of Electrobun with file associations, app protocol/deep links, managed service startup, and the shell glue needed to make the app feel normal to non-technical users.

## Prior Context

- `fn-41-document-workspace-foundation-for` is already complete. That means GNO now has: read-only converted-document handling, editable markdown copies, optimistic save conflicts, local editor snapshots, deep links with line targets, live document-refresh plumbing, wiki-link autocomplete, and a fast Cmd/Ctrl+K quick switcher.
- The larger goal is not just “native app”, but “usable for Gordon's team and normies”: install easily, connect agents easily, understand what is happening, and trust the product without using the terminal.
- `docs/` is the source of truth for product behavior and architecture decisions. If behavior changes, update docs and website in the same implementation.
- `fn-50` now treats Electrobun as the working shell direction. The remaining question is how much glue GNO carries itself versus what gets upstreamed.

## Difficulty

Hard.

## Why now

This is the first truly normie-visible desktop milestone. With Electrobun selected, the question becomes execution quality, not framework shopping.

## Start Here

- `desktop/electrobun-spike/`
- `plans/electrobun-spike.md`
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
- If Electrobun still lacks a built-in singleton API, GNO can ship an app-level singleton handoff.
- If Electrobun still lacks first-class file-association support, GNO can use packaging hooks / plist injection as an interim path.
- Tabs and simultaneous editors are app-level workspace behavior, not native BrowserView tabs.

## Scope

- Electrobun shell wrapper around the existing GNO workspace
- service startup/shutdown management
- file associations for markdown/plaintext, with open-file routing into GNO
- single-instance handoff / reopen behavior
- deep-link/app protocol integration
- docs for install/open-file behavior

## Explicit Non-goals

- signing/notarization/updater work
- org rollout process
- native BrowserView tab implementation

## Required Deliverables

- working packaged Electrobun shell for the chosen target OS
- open-file, app-protocol, and single-instance handoff flows
- file-type registration strategy for markdown/plaintext
- updated install/open-file docs
- end-to-end verification for launch/open/deep-link behavior on target OSes

## Acceptance

- Users can install and open GNO like a normal desktop app.
- Opening an associated file or deep link routes into the existing workspace cleanly.
- Shell-specific glue remains thin and documented.
