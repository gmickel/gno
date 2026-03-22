# Desktop Beta: Background Service and Watch Hardening

## Overview

Harden the service layer behind the workspace so it behaves predictably across larger folders, long-running sessions, sleep/wake cycles, and desktop-style app lifecycles.

## Prior Context

- `fn-41-document-workspace-foundation-for` is already complete. That means GNO now has: read-only converted-document handling, editable markdown copies, optimistic save conflicts, local editor snapshots, deep links with line targets, live document-refresh plumbing, wiki-link autocomplete, and a fast Cmd/Ctrl+K quick switcher.
- The larger goal is not just “native app”, but “usable for Gordon's team and normies”: install easily, connect agents easily, understand what is happening, and trust the product without using the terminal.
- `docs/` is the source of truth for product behavior and architecture decisions. If behavior changes, update docs and website in the same implementation.
- Until the explicit runtime evaluation epic, keep implementation stack-agnostic. Do not prematurely lock the product to Tauri/Electron/Electrobun-specific assumptions outside the runtime/shell epics.

## Difficulty

Medium to hard.

## Why now

This is the main reliability prerequisite before native packaging and wider team rollout.

## Start Here

- `src/serve/watch-service.ts`
- `src/serve/doc-events.ts`
- `src/serve/server.ts`
- `src/serve/public/hooks/use-doc-events.ts`
- `src/serve/embed-scheduler.ts`
- `docs/WEB-UI.md`

## Dependencies

- Blocked by: `fn-41-document-workspace-foundation-for`, `fn-42-desktop-beta-onboarding-and-health`
- Unblocks: `fn-49`, `fn-50`
- This is the reliability gate before shell/runtime decisions should be finalized.

## Constraints Already Decided

- Instant reindex and external-change awareness already exist from `fn-41`; this epic is about making them durable and trustworthy.
- Prefer observability and deterministic behavior over clever background heuristics.
- Keep the service boundary reusable for both web-first and later desktop-shell execution.

## Scope

- watcher reliability and dedupe hardening
- sleep/wake/network-drive edge cases
- background service lifecycle
- backlog/indexing state visibility
- resilience tests and observability

## Explicit Non-goals

- Native shell framework decision
- signed app distribution

## Required Deliverables

- Hardened watcher/service lifecycle behavior
- User-visible indexing/backlog state that matches reality
- Resilience tests for sleep/wake/external-change scenarios where practical
- Observability and troubleshooting docs updates

## Acceptance

- Long-running sessions remain trustworthy.
- Users get accurate indexing state and fewer "why didn't it refresh" incidents.
