# Desktop Beta: Recovery, Restore, and Support Bundle

## Overview

Build the supportability layer for non-technical users: visible history, restore flows, diagnostics export, and a support bundle that makes field debugging tractable.

## Prior Context

- `fn-41-document-workspace-foundation-for` is already complete. That means GNO now has: read-only converted-document handling, editable markdown copies, optimistic save conflicts, local editor snapshots, deep links with line targets, live document-refresh plumbing, wiki-link autocomplete, and a fast Cmd/Ctrl+K quick switcher.
- The larger goal is not just “native app”, but “usable for Gordon's team and normies”: install easily, connect agents easily, understand what is happening, and trust the product without using the terminal.
- `docs/` is the source of truth for product behavior and architecture decisions. If behavior changes, update docs and website in the same implementation.
- Until the explicit runtime evaluation epic, keep implementation stack-agnostic. Do not prematurely lock the product to Tauri/Electron/Electrobun-specific assumptions outside the runtime/shell epics.

## Difficulty

Medium.

## Why now

Once GNO becomes people's real workspace, support/recovery quality matters as much as features.

## Start Here

- `src/serve/public/lib/local-history.ts`
- `src/serve/public/pages/DocumentEditor.tsx`
- `src/serve/public/pages/DocView.tsx`
- `docs/TROUBLESHOOTING.md`
- `src/cli/commands/doctor.ts`

## Dependencies

- Blocked by: `fn-41-document-workspace-foundation-for`, `fn-46-desktop-beta-file-lifecycle-and-finder`
- This epic should expand the local-history/conflict groundwork already shipped in `fn-41`.

## Constraints Already Decided

- Support flows must help non-technical users recover first, escalate second.
- Exported diagnostics must avoid hidden one-off tribal knowledge; all interpretation guidance should live in docs/app copy.
- Restore UX should align with the read-only vs editable capability model.

## Scope

- visible local-history browser
- restore / compare revisions UI
- support bundle export (config, logs, health, versions)
- self-diagnosis checklist in app
- docs/support workflow

## Explicit Non-goals

- Native runtime selection
- OS packaging/update work

## Required Deliverables

- History/revision browser UI
- Restore/compare flows with clear safety copy
- One-click support bundle export
- Troubleshooting docs/support workflow updates
- Tests around restore/export paths where practical

## Acceptance

- Users can recover from mistakes without engineering help in common cases.
- Support/debug data can be exported in one action.
