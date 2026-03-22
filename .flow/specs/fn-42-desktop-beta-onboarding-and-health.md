# Desktop Beta: Onboarding and Health Center

## Overview

Build the first-run experience for non-technical users: pick folders, validate prerequisites, choose a preset in plain language, and explain system health without requiring terminal commands.

## Prior Context

- `fn-41-document-workspace-foundation-for` is already complete. That means GNO now has: read-only converted-document handling, editable markdown copies, optimistic save conflicts, local editor snapshots, deep links with line targets, live document-refresh plumbing, wiki-link autocomplete, and a fast Cmd/Ctrl+K quick switcher.
- The larger goal is not just “native app”, but “usable for Gordon's team and normies”: install easily, connect agents easily, understand what is happening, and trust the product without using the terminal.
- `docs/` is the source of truth for product behavior and architecture decisions. If behavior changes, update docs and website in the same implementation.
- Until the explicit runtime evaluation epic, keep implementation stack-agnostic. Do not prematurely lock the product to Tauri/Electron/Electrobun-specific assumptions outside the runtime/shell epics.

## Difficulty

Easy.

## Why first

This is stack-agnostic and immediately improves usability whether GNO stays web-first for a while or moves into a native shell later.

## Start Here

- `src/serve/public/pages/Dashboard.tsx`
- `src/serve/public/pages/Collections.tsx`
- `src/serve/public/components/AIModelSelector.tsx`
- `src/serve/public/components/IndexingProgress.tsx`
- `src/serve/public/hooks/use-api.ts`
- `docs/QUICKSTART.md`
- `docs/INSTALLATION.md`
- `website/index.md`
- `website/_data/faq.yml`

## Dependencies

- Blocked by: `fn-41-document-workspace-foundation-for`
- Unblocks: `fn-43`, `fn-44`, `fn-45`, `fn-48`
- This epic should establish the app-level onboarding/health pattern that later desktop-shell work can reuse.

## Constraints Already Decided

- Preserve the `fn-41` capability contract: markdown/plaintext editable; converted docs read-only with editable-copy flow.
- Reuse existing web workspace surfaces first; do not assume a native shell exists yet.
- Health copy must explain actual system state, not generic “something went wrong” placeholders.

## Scope

- first-run wizard
- folder picker / collection selection UX
- plain-language preset chooser
- health center for indexing, model readiness, disk, and common fix actions
- user-facing error copy and empty states

## Explicit Non-goals

- Native shell packaging
- signing / notarization / updater work
- deep desktop OS integration

## Required Deliverables

- Productized first-run entrypoint in the existing app
- Health/status model with actionable fix guidance
- Tests for first-run and broken-state paths where practical
- Docs/website updates for onboarding and troubleshooting

## Acceptance

- A new user can open GNO and get from zero to indexed folders without reading CLI docs.
- Health/status surfaces clearly explain what is broken and how to fix it.
- Docs/website onboarding copy matches the actual first-run flow.
