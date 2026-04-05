# fn-62-authoring-accelerators-and-note-presets Authoring accelerators and note presets

## Overview

Speed up note creation/editing for GNO's actual audience: developers, researchers, and agents working on structured local knowledge.

This is not about daily notes or a sprawling template marketplace. It is about high-leverage accelerators:

- presets
- insert actions
- structured frontmatter helpers
- slash-command style creation aids where they materially help

## Prior Context

- Note creation and editor basics already exist.
- Wiki-link autocomplete already exists.
- Metadata/frontmatter handling is already part of the product identity.
- The current gap is repetition: people keep creating the same note shapes manually.
- `docs/adr/001-scholarly-dusk-design-system.md` is the canonical design reference for editor/create flows.

## Why now

- Once creation is native, speed becomes the next friction point.
- Agent-first workflows benefit from explicit note presets and structured creation contracts more than from human-journal features like daily notes.

## Difficulty

Medium.

## Start Here

- `src/serve/public/pages/DocumentEditor.tsx`
- `src/serve/public/components/CaptureModal.tsx`
- `src/serve/public/components/editor/*`
- `src/serve/routes/api.ts`
- `docs/WEB-UI.md`
- `docs/API.md`
- `docs/adr/001-scholarly-dusk-design-system.md`

## Scope

- note presets
- preset-aware creation flow
- frontmatter presets / metadata presets
- insert accelerators for common note structures
- slash-command style insert surface if it earns its complexity
- preset contract shared across UI / CLI / SDK / MCP wherever presets are exposed
- docs, website, tests

## Explicit Non-goals

- daily notes
- generic template gallery
- marketplace/plugin template ecosystem
- fully programmable snippet engine in first pass

## Product Stance

- Favor a small number of strong presets over a huge template system.
- Presets should produce structured, durable notes that help both humans and agents.
- Frontmatter should be explicit, not hidden magic.
- Preset pickers and insert surfaces must feel native to the Scholarly Dusk workspace, not like bolted-on productivity widgets.

## Requirements

- Users can choose from note presets during creation.
- Presets can define:
  - default title shape or suggestion
  - frontmatter fields
  - starter body scaffold
  - tags/category defaults
- Presets are reusable across:
  - quick capture
  - browse-scoped creation
  - open-or-create flows
- Editor exposes a fast insertion path for preset sections or common structured blocks if useful.
- Preset definitions live in a shared typed model, not hardcoded ad hoc in multiple React components.

## Candidate First-pass Presets

- project note
- research note
- decision note
- prompt/pattern note
- source summary

## UX Deliverables

- preset picker in note creation
- clear preview of what the preset adds
- frontmatter/body scaffold visible before save
- lightweight insert surface inside editor when useful
- UI treatment consistent with Scholarly Dusk typography, chips, rails, and command surfaces

## Technical Deliverables

- shared preset model + resolver
- creation API support for preset application
- tests for:
  - preset expansion
  - frontmatter generation
  - editor/capture flows using presets
- docs updates in `docs/`
- website updates where note creation/editor flows are described

## Architecture Rule

Presets are product data, not UI-only labels.

Build them so applicable surfaces stay in parity:

- Web UI
- SDK
- CLI
- MCP
- agent skills wrapping CLI/API

Matching surfaces must share:

- preset definitions
- frontmatter/body scaffold semantics
- validation
- result shapes

## Risks / Design Traps

- building a template system too broad for real usage
- presets becoming hidden text macros with no typed structure
- multiple creation surfaces applying presets differently

## Quick commands

- `bun run lint:check`
- `bun test`
- `bun run test:e2e`

## Acceptance

- [ ] Note presets exist and are usable in main creation flows.
- [ ] Presets can scaffold frontmatter and body content.
- [ ] Preset semantics live in shared typed logic.
- [ ] No daily-note or generic template sprawl is introduced.
- [ ] New UI follows `docs/adr/001-scholarly-dusk-design-system.md`.
- [ ] Docs in `docs/`, website copy/pages, and tests all reflect the new authoring accelerator model.
