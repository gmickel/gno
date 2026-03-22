# Desktop Beta: Runtime and Model Bootstrap

## Overview

Define how a normie install gets the runtime and models it needs without manual Bun/model setup, while keeping disk and download behavior understandable.

## Prior Context

- `fn-41-document-workspace-foundation-for` is already complete. That means GNO now has: read-only converted-document handling, editable markdown copies, optimistic save conflicts, local editor snapshots, deep links with line targets, live document-refresh plumbing, wiki-link autocomplete, and a fast Cmd/Ctrl+K quick switcher.
- The larger goal is not just “native app”, but “usable for Gordon's team and normies”: install easily, connect agents easily, understand what is happening, and trust the product without using the terminal.
- `docs/` is the source of truth for product behavior and architecture decisions. If behavior changes, update docs and website in the same implementation.
- Until the explicit runtime evaluation epic, keep implementation stack-agnostic. Do not prematurely lock the product to Tauri/Electron/Electrobun-specific assumptions outside the runtime/shell epics.

## Difficulty

Hard.

## Why now

Distribution quality depends on deciding what is bundled, downloaded later, or shared between installs.

## Start Here

- `package.json`
- `docs/INSTALLATION.md`
- `docs/CONFIGURATION.md`
- `docs/FINE-TUNED-MODELS.md`
- model cache / download policy code under `src/llm/`

## Dependencies

- Blocked by: `fn-41-document-workspace-foundation-for`, `fn-48-desktop-beta-background-service-and`
- Unblocks: `fn-51`
- This epic should stay mostly stack-agnostic even though it informs later shell work.

## Constraints Already Decided

- Normies should not have to install Bun manually in the final product path.
- Runtime/model downloads must be explainable in plain language: what is bundled, what is fetched later, where it lives, how large it is.
- Bootstrap behavior should not hide failure states that later make onboarding/support impossible.

## Scope

- bundled vs on-demand runtime strategy
- bundled vs on-demand model strategy
- download UX, disk usage UX, cache management
- first-run bootstrap performance targets
- docs for footprint/troubleshooting

## Explicit Non-goals

- Shell UI/window work
- app protocol / file associations

## Required Deliverables

- Documented bootstrap strategy and implementation hooks
- User-facing disk/download/status UX
- Troubleshooting/docs updates for runtime/model provisioning
- Validation around first-run/bootstrap success and failure paths

## Acceptance

- Installation and first-run model/runtime behavior is predictable and explainable.
- Disk/download tradeoffs are visible to users instead of implicit.
