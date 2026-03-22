# Desktop Beta: Signed Distribution, Updates, and Team Rollout

## Overview

Finish the last mile for team-wide adoption: signed builds, updater/release channels, installer distribution, rollout playbooks, and managed defaults.

## Prior Context

- `fn-41-document-workspace-foundation-for` is already complete. That means GNO now has: read-only converted-document handling, editable markdown copies, optimistic save conflicts, local editor snapshots, deep links with line targets, live document-refresh plumbing, wiki-link autocomplete, and a fast Cmd/Ctrl+K quick switcher.
- The larger goal is not just “native app”, but “usable for Gordon's team and normies”: install easily, connect agents easily, understand what is happening, and trust the product without using the terminal.
- `docs/` is the source of truth for product behavior and architecture decisions. If behavior changes, update docs and website in the same implementation.
- Until the explicit runtime evaluation epic, keep implementation stack-agnostic. Do not prematurely lock the product to Tauri/Electron/Electrobun-specific assumptions outside the runtime/shell epics.

## Difficulty

Hardest.

## Why last

This work is only worth doing once the app shell and core workspace are stable enough to support normie installs at scale.

## Start Here

- shell packaging result from `fn-51`
- agent connector flow from `fn-43`
- existing release/publish workflow docs and automation
- website / install docs / changelog flow

## Dependencies

- Blocked by: `fn-43-desktop-beta-in-app-agent-connector`, `fn-51-desktop-beta-shell-packaging-and-os`
- Final milestone in the current desktop-beta sequence.

## Constraints Already Decided

- Distribution is only “done” when a non-technical team can install, update, and connect agents without terminal work.
- Release automation, docs, and support playbooks count as product surface here, not cleanup.
- Managed defaults must not obscure where user data lives or how updates change behavior.

## Scope

- signing / notarization / installer packaging
- auto-update or managed update path
- release channels (stable/beta)
- team rollout docs/checklists
- managed defaults / recommended settings for org installs

## Explicit Non-goals

- Core workspace feature development
- native runtime evaluation

## Required Deliverables

- Signed/notarized installer artifacts for the target platform(s)
- Update channel/release process that support can actually run
- Rollout and rollback docs/checklists
- Website/install docs/changelog updates for the distribution path

## Acceptance

- GNO can be distributed to a non-technical team through a normal software rollout path.
- Updating is safe and supportable.
