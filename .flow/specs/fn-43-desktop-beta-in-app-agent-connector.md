# Desktop Beta: In-App Agent Connector Center

## Overview

Add one place in the app to install, verify, and troubleshoot GNO skill/MCP connections for Claude Code, Codex, OpenCode, OpenClaw, Cursor, and related agent tools.

## Prior Context

- `fn-41-document-workspace-foundation-for` is already complete. That means GNO now has: read-only converted-document handling, editable markdown copies, optimistic save conflicts, local editor snapshots, deep links with line targets, live document-refresh plumbing, wiki-link autocomplete, and a fast Cmd/Ctrl+K quick switcher.
- The larger goal is not just “native app”, but “usable for Gordon's team and normies”: install easily, connect agents easily, understand what is happening, and trust the product without using the terminal.
- `docs/` is the source of truth for product behavior and architecture decisions. If behavior changes, update docs and website in the same implementation.
- Until the explicit runtime evaluation epic, keep implementation stack-agnostic. Do not prematurely lock the product to Tauri/Electron/Electrobun-specific assumptions outside the runtime/shell epics.

## Difficulty

Easy to medium.

## Why now

This is one of the highest-leverage normie wins and does not require choosing the native shell tech first.

## Start Here

- `src/cli/commands/skill/`
- `src/cli/commands/mcp/`
- `assets/skill/SKILL.md`
- `docs/integrations/skills.md`
- `docs/MCP.md`
- `docs/integrations/claude-desktop.md`
- `README.md`

## Dependencies

- Blocked by: `fn-41-document-workspace-foundation-for`, `fn-42-desktop-beta-onboarding-and-health`
- Unblocks: `fn-52`
- This epic should build on the existing CLI installers instead of inventing a second install protocol.

## Constraints Already Decided

- Reuse existing `gno skill install` and `gno mcp install` flows where possible.
- Do not introduce new agent-only write primitives just for this epic.
- Explain capability/read-only behavior in user terms so agent users understand what GNO will edit vs only read.

## Scope

- detect installed agent apps/config roots
- one-click skill/MCP install from the app
- verification and troubleshooting state
- explain read-only vs write-enabled modes in plain language
- docs/website integration setup updates

## Explicit Non-goals

- New MCP/write tool surface beyond what the product already exposes
- native shell selection

## Required Deliverables

- Detect/install/verify UX for the supported agent targets
- Plain-language success/failure states
- Updated integration docs and website guidance
- Regression coverage for target detection/install plumbing where practical

## Acceptance

- A non-technical user can connect at least the core supported agent apps without editing JSON manually.
- The app can tell whether GNO is installed correctly and suggest next actions.
