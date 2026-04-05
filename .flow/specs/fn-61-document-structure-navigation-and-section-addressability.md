# fn-61-document-structure-navigation-and-section-addressability Document structure navigation and section addressability

## Overview

Make long notes easier to read, navigate, cite, and reuse by turning document structure into a first-class workspace concept.

This epic centers on heading/section navigation, but should also cover the broader "document anatomy" layer that power users expect when living in notes all day.

## Prior Context

- DocView now has much better metadata/frontmatter/link panels.
- GNO already supports deep links with line targets and note-level navigation.
- The current gap is inside-document navigation and section-level addressability.
- `docs/adr/001-scholarly-dusk-design-system.md` defines the rail/panel/layout vocabulary this work should extend.

## Why now

- Obsidian replacement requires stronger reading/navigation ergonomics, not just file-level browsing.
- Long notes, research writeups, and agent-generated docs need section-level movement.
- Agents and APIs also benefit from stable section targets.

## Difficulty

Medium.

## Start Here

- `src/serve/public/pages/DocView.tsx`
- `src/serve/public/components/editor/MarkdownPreview.tsx`
- `src/serve/public/lib/*`
- `src/serve/routes/api.ts`
- `docs/WEB-UI.md`
- `docs/API.md`
- `docs/adr/001-scholarly-dusk-design-system.md`

## Scope

- heading navigator / outline pane
- section jump links
- stable heading-anchor generation
- copy deep link to section
- current-section highlighting while scrolling where practical
- section-aware quick navigation commands
- section metadata/addressability contract usable by API/SDK later
- docs, website, tests

## Explicit Non-goals

- block-level editing model
- full block reference system
- canvas or whiteboard views
- daily-notes-specific affordances

## Product Stance

- Prefer section/heading addressability first; block-level identity can come later if still needed.
- Build this as a reusable document-structure layer, not a DocView-only ornament.
- Structure navigation UI should extend Scholarly Dusk rails/panels instead of adding generic editor chrome.

## Requirements

- DocView can show a heading outline for markdown-like documents.
- Users can jump to sections quickly.
- Users can copy/open deep links to a section.
- Anchor generation is stable and predictable.
- API/SDK/MCP surfaces should expose the same section structure without reimplementing parser rules per surface.
- Works especially well for:
  - research notes
  - long docs
  - agent-generated summaries/designs

## UX Deliverables

- outline pane or section navigator
- current section highlight
- section actions:
  - copy link
  - jump
  - maybe open in source/editor at heading
- empty-state behavior for docs without headings
- section/navigation controls that match existing Scholarly Dusk rail density and typography

## Technical Deliverables

- shared heading/section extraction layer
- stable slug/anchor rules
- reusable section link builder
- tests for:
  - heading extraction
  - slug stability
  - section deep links
  - DocView section navigation behavior
- docs updates in `docs/`
- website updates where reading/navigation/workspace capabilities are described

## Architecture Rule

Document structure is data, not just UI chrome.

Expose it through shared types/helpers so all applicable surfaces can stay in parity:

- Web UI
- SDK
- API
- MCP section-aware retrieval or navigation helpers

## Risks / Design Traps

- anchors changing after minor formatting tweaks
- parsing rules diverging between source mode and rendered mode
- over-building a mini block editor instead of solving section navigation cleanly

## Quick commands

- `bun run lint:check`
- `bun test`
- `bun run test:e2e`

## Acceptance

- [ ] Long notes expose a heading/section navigator in DocView.
- [ ] Users can jump to and deep-link specific sections.
- [ ] Section extraction and anchor generation live in shared logic.
- [ ] New UI follows `docs/adr/001-scholarly-dusk-design-system.md`.
- [ ] Docs in `docs/`, website copy/pages, and tests all reflect section-level navigation/addressability.
