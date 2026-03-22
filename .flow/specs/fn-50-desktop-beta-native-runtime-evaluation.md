# Desktop Beta: Native Runtime Evaluation and Abstraction

## Overview

Evaluate the native shell/runtime options, including the Bun-based path you want to investigate, and define an abstraction boundary so the app shell can evolve without rewriting the workspace core.

## Prior Context

- `fn-41-document-workspace-foundation-for` is already complete. That means GNO now has: read-only converted-document handling, editable markdown copies, optimistic save conflicts, local editor snapshots, deep links with line targets, live document-refresh plumbing, wiki-link autocomplete, and a fast Cmd/Ctrl+K quick switcher.
- The larger goal is not just “native app”, but “usable for Gordon's team and normies”: install easily, connect agents easily, understand what is happening, and trust the product without using the terminal.
- `docs/` is the source of truth for product behavior and architecture decisions. If behavior changes, update docs and website in the same implementation.
- Until the explicit runtime evaluation epic, keep implementation stack-agnostic. Do not prematurely lock the product to Tauri/Electron/Electrobun-specific assumptions outside the runtime/shell epics.

## Difficulty

Hard.

## Why now

This is the first intentionally stack-dependent epic, and it should happen after the reusable workspace/service pieces are in place.

## Start Here

- `fn-7` legacy Desktop App epic for historical context
- `src/serve/server.ts`
- `src/serve/public/app.tsx`
- the watch/event/deep-link work from `fn-41`
- external candidates such as Electrobun, Tauri, Electron

## Dependencies

- Blocked by: `fn-41-document-workspace-foundation-for`, `fn-48-desktop-beta-background-service-and`
- Unblocks: `fn-51`
- This is the first epic where a shell/runtime choice is allowed and expected.

## Constraints Already Decided

- Evaluate Electrobun explicitly, but do not assume it wins before the spike proves the critical requirements.
- The chosen abstraction must keep core workspace logic independent from shell-specific APIs.
- Decision criteria must reflect the actual product goals: normie install path, agent connectivity, file/open integration, deep links, updater/signing fit, and operational trust.

## Scope

- evaluate Bun-based desktop option vs Tauri/Electron/other contenders
- compare bundle size, startup, update path, file-association support, and signing/notarization fit
- define service/window/deep-link abstraction boundary
- record final recommendation in repo docs

## Explicit Non-goals

- Shipping a packaged desktop app in this epic
- signing/notarization work

## Required Deliverables

- Evaluation matrix with explicit pass/fail criteria
- At least one thin spike/prototype for the leading option if needed to de-risk unknowns
- Repo docs that record the decision, tradeoffs, and boundary rules
- Clear recommendation for what `fn-51` should implement

## Acceptance

- We have a documented stack decision with explicit tradeoffs.
- The chosen runtime boundary does not leak desktop-framework specifics into core workspace logic.
