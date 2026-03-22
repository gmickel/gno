# Desktop Beta: Native Runtime Evaluation and Abstraction

## Overview

Electrobun is now the working runtime direction for the mac-first desktop beta. This epic validates the remaining Electrobun-specific risks, defines the shell boundary, and decides which missing pieces should be upstreamed versus owned in GNO.

## Prior Context

- `fn-41-document-workspace-foundation-for` is already complete. That means GNO now has: read-only converted-document handling, editable markdown copies, optimistic save conflicts, local editor snapshots, deep links with line targets, live document-refresh plumbing, wiki-link autocomplete, and a fast Cmd/Ctrl+K quick switcher.
- The larger goal is not just “native app”, but “usable for Gordon's team and normies”: install easily, connect agents easily, understand what is happening, and trust the product without using the terminal.
- `docs/` is the source of truth for product behavior and architecture decisions. If behavior changes, update docs and website in the same implementation.
- The current spike work shows: packaged `gno://` support works, singleton is solvable with app-level glue, `open-file` / default-app handling is the main missing capability, and native BrowserView tabs are not the right model for GNO.

## Difficulty

Hard.

## Why now

The shell direction is strong enough to move forward. This epic is no longer a broad bakeoff; it is now about de-risking Electrobun's known gaps before `fn-51`.

## Start Here

- `desktop/electrobun-spike/`
- `plans/electrobun-spike.md`
- current spike branch: `feat/fn-50-electrobun-spike`
- `src/serve/server.ts`
- `src/serve/public/app.tsx`
- the watch/event/deep-link work from `fn-41`
- upstream Electrobun issues `#227`, `#304`, `#69`, `#253`
- local Electrobun checkout in `~/repos/electrobun`

## Fresh-Agent Handoff

- Working decision today: proceed with Electrobun for the mac-first beta unless `open-file` / file-association or distribution work proves unacceptable.
- Spike evidence already lives in:
  - `desktop/electrobun-spike/`
  - `plans/electrobun-spike.md`
- Local upstream checkout for investigation/patching:
  - `/Users/gordon/repos/electrobun`
- Important upstream gaps:
  - `#227` no built-in single-instance API
  - `#304` no `application:openFiles` support on macOS
  - `#69` reopen-window request
  - `#253` multitab template instability
- Important conclusions already reached:
  - packaged `gno://` works
  - singleton is solvable with app-level glue
  - tabs should live in GNO app state, not native BrowserView tabs
  - the main unresolved product risk is `open-file` / file associations

## Dependencies

- Blocked by: `fn-41-document-workspace-foundation-for`, `fn-48-desktop-beta-background-service-and`
- Unblocks: `fn-51`
- Electrobun is the primary path unless its open-file / distribution path proves unacceptable.

## Constraints Already Decided

- Electrobun is the working direction for the mac-first beta.
- Keep the chosen abstraction such that core workspace logic remains independent from shell-specific APIs.
- App-level singleton handoff is acceptable if Electrobun does not ship a first-class API in time.
- App-level tabs are the GNO model; do not build GNO around Electrobun's current BrowserView multitab template.
- Only fall back to another runtime if Electrobun fails on open-file / file-association or distribution fundamentals.

## Scope

- validate and harden Electrobun singleton handoff / reopen behavior
- prove the `open-file` and file-association path, either by upstream patch, local patch, or packaging hook
- define what GNO owns versus what should be upstreamed to Electrobun
- confirm the service/window/deep-link boundary for the Electrobun shell
- document the fallback trigger if Electrobun still fails a must-have capability

## Explicit Non-goals

- generic runtime bakeoff unless Electrobun fails the above gates
- shipping the production desktop app in this epic
- tabs implementation
- signing/notarization rollout work

## Required Deliverables

- documented Electrobun go/no-go for `fn-51`
- explicit singleton strategy
- explicit `open-file` / file-association strategy
- upstream-vs-local ownership decision for any required patches
- repo docs that record the boundary and remaining risks

## Acceptance

- We have a documented Electrobun decision with explicit remaining risks.
- Single-instance, open-url, and open-file stories are all either proven or assigned a clear implementation path.
- The chosen runtime boundary does not leak desktop-framework specifics into core workspace logic.
