# fn-63-workspace-native-commands-and-agent-callable-actions Workspace-native commands and agent-callable actions

## Overview

Turn the existing quick-switcher into a serious command surface for the workspace.

This epic is about commands that make sense for GNO's target audience:

- developers
- researchers
- agent-heavy users

The command system should not just be UI polish. It should provide one shared action vocabulary and semantic core so CLI, SDK, MCP, and UI can stay in parity where the same actions are exposed.

## Prior Context

- Quick-switcher, recents, favorites, and pinned collections already exist.
- Tabs and Browse now provide strong workspace context.
- The workspace already has a `?` shortcuts/help surface via `ShortcutHelpModal`; command work should build on that instead of replacing it blindly.
- Upcoming epics define note creation, file ops, structure navigation, and presets. Those need a coherent command/action layer.
- `docs/adr/001-scholarly-dusk-design-system.md` defines the aesthetic/interaction language command surfaces should inherit.

## Why now

- Obsidian feels powerful partly because commands are everywhere.
- GNO's audience is even more command/action driven than Obsidian's average user.
- Agents also benefit if workspace actions are defined as reusable operations instead of hidden UI-only handlers.

## Difficulty

Medium to hard.

## Start Here

- `src/serve/public/components/QuickSwitcher.tsx`
- `src/serve/public/components/ShortcutHelpModal.tsx`
- `src/serve/public/hooks/useKeyboardShortcuts.ts`
- `src/serve/public/app.tsx`
- future action/command layer under `src/serve/public/lib/*`
- `docs/WEB-UI.md`
- `docs/API.md`
- `docs/MCP.md`
- `docs/adr/001-scholarly-dusk-design-system.md`

## Scope

- command palette evolution of quick-switcher
- integration with the existing `?` help/shortcuts surface
- typed action registry
- context-aware commands
- command execution for:
  - open/create note
  - navigate browse/tree
  - file ops
  - section jumps
  - preset-based creation
  - tab actions where useful
- command discoverability and keyboard UX
- agent-callable/shared action contracts where relevant
- docs, website, tests

## Explicit Non-goals

- generic plugin command marketplace
- every UI button becoming an exposed command in first pass
- voice control or macro recorder

## Product Stance

- Commands should feel native to GNO's workspace, not copied from Obsidian mechanically.
- Prefer fewer powerful actions over a giant weak command list.
- Action semantics should be shared and typed, not duplicated across modal handlers.
- The command palette must extend the Scholarly Dusk visual language instead of reverting to generic command-menu styling.

## Requirements

- Quick-switcher evolves into a true command palette with action grouping.
- Commands can use current workspace context:
  - active tab
  - selected browse folder
  - current document
  - current section where relevant
- Commands cover the core workspace operations introduced in epics 59-62.
- Shared action contracts define parity across applicable surfaces, not just the command palette.

## Candidate First-pass Commands

- open or create note
- create note in current folder
- rename current note
- move current note
- duplicate current note
- create folder in current browse location
- jump to section
- copy section link
- apply preset
- pin/unpin collection
- favorite/unfavorite note
- open graph
- open browse
- open search / ask

## UX Deliverables

- command palette UI
- grouped actions
- context hints
- keyboard-first flows
- strong empty states when a command requires context the user does not currently have
- Scholarly Dusk-consistent panel, typography, and action-row treatment
- existing `?` help surface updated so new commands stay discoverable

## Technical Deliverables

- typed command/action registry
- context resolution layer
- reusable executor layer
- tests for:
  - command registration
  - command filtering/ranking
  - context gating
  - execution behavior for representative actions
- docs updates in `docs/`
- website updates where command/workspace navigation capabilities are described

## Architecture Rule

Build commands as shared workspace actions, not just command-palette callbacks.

That means parity across applicable surfaces:

- one action contract
- UI can invoke it
- CLI can invoke it where applicable
- SDK can invoke it where applicable
- MCP can invoke it where safe/applicable
- matching surfaces share validation, conflict handling, and result semantics

## Risks / Design Traps

- quick-switcher becoming a cluttered omnibox
- action semantics drifting from actual UI behavior
- exposing unsafe write operations to future agent surfaces without proper guardrails

## Quick commands

- `bun run lint:check`
- `bun test`
- `bun run test:e2e`

## Acceptance

- [ ] GNO has a real command palette / action surface, not just a document jumper.
- [ ] Core workspace operations are available as typed, context-aware actions.
- [ ] Action semantics are reusable outside the immediate UI.
- [ ] New UI follows `docs/adr/001-scholarly-dusk-design-system.md`.
- [ ] Existing `?` help surface is updated for discoverability.
- [ ] Docs in `docs/`, website copy/pages, and tests all reflect the new command/action model.
