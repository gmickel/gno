# fn-63 Workspace-native commands and agent-callable actions

## Goal & Context
<!-- scope: business -->

Deliver a keyboard-first command surface for GNO's workspace without turning the product into a generic action-bus framework. The useful product outcome is already present on main: QuickSwitcher combines document discovery, recents, favorites, section jumps, presets, and contextual workspace commands; the `?` surface teaches the shortcuts; typed UI action descriptors keep command availability and labels coherent.

This revision reconciles the stale Flow state with the shipped product. A universal UI/CLI/SDK/MCP action protocol is deliberately not retained as unfinished scope. Those surfaces have different safety and transport semantics, and the current direct typed APIs are clearer than an unproven generic executor. A future cross-surface action protocol requires a concrete user workflow and at least three operations whose duplicated semantics cannot be solved in their owning feature specs.

## Architecture & Data Models
<!-- scope: technical -->

Shipped baseline:

- `src/serve/public/lib/workspace-actions.ts:4-225` owns typed UI action IDs, descriptors, context filtering, and execution routing.
- `src/serve/public/components/QuickSwitcher.tsx:318-635` composes search, sections, presets, and action rows into the command palette.
- `src/serve/public/components/ShortcutHelpModal.tsx:171-236` exposes keyboard discoverability.
- Direct REST, SDK, and write-gated MCP operations remain the semantic owners for mutations; the command palette invokes product routes/events rather than bypassing their validation.

No new shared action schema, generic remote executor, or database model belongs to this completed spec.

## API Contracts
<!-- scope: technical -->

The delivered contract is UI-local and typed:

- each action has a stable ID, label, group, search terms, and context-dependent availability;
- invocation uses the current workspace context and routes to an existing product operation;
- unavailable actions remain undiscoverable or explain their missing context in the owning UI;
- API, SDK, and MCP keep their existing operation-specific schemas and write gates.

MCP tool annotations or UI action descriptors are never authorization. Any future agent-callable action layer must preserve the existing MCP/API capability checks and explicit destructive confirmation rules.

## Edge Cases & Constraints
<!-- scope: technical -->

- The palette must not become a second implementation of file, note, or section operations.
- Candidate commands in the original roadmap were examples, not a requirement that every UI action appear on every transport.
- Browser custom events are acceptable orchestration inside the shipped UI; they are not a cross-process protocol.
- A generic action registry would increase versioning and security surface without current evidence of user value.
- Existing keyboard navigation, search ranking, section precedence, and empty-input command discovery remain regression-covered.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** QuickSwitcher behaves as a command palette, showing useful contextual actions before the user types while retaining document search, recents, favorites, presets, and section navigation.
- **R2:** Workspace command descriptors and execution routing are typed and centralized in the UI rather than duplicated across palette rows.
- **R3:** The existing `?` help surface documents the relevant keyboard and command-palette behavior.
- **R4:** Direct API, SDK, and MCP operations retain their operation-specific validation and write gates; no UI descriptor is treated as authorization.
- **R5:** Focused command-palette, API, SDK, and MCP tests pass on current main.
- **R6:** No generic cross-surface action bus is left as implied unfinished work; reopening that idea requires concrete duplication and user-workflow evidence.

## Boundaries
<!-- scope: business -->

- No plugin command marketplace, macro recorder, voice control, or arbitrary remote action executor.
- No requirement for every UI command to exist in CLI, SDK, or MCP.
- No new implementation work in this closure revision.
- Feature-specific semantic gaps remain owned by their feature specs, especially fn-60 and fn-61.

## Decision Context
<!-- scope: both — conditionally substructured -->

The original product feature shipped. Extending it into a universal action vocabulary now would be speculative architecture: the current transports intentionally expose different contracts, permissions, and interaction models. Closing fn-63 keeps the valuable palette while avoiding an abstraction that has not earned its cost. If repeated drift later appears across several operations, capture that evidence in a new, narrowly scoped spec instead of reopening this one by default.

## Quick commands

```bash
bun test test/serve/public/components/QuickSwitcher.dom.test.tsx test/mcp/tools/workspace-write.test.ts test/sdk/client.test.ts
bun run lint:check
```

## Early proof point

Historical task fn-63.1 established the typed UI registry reused by the palette. Current focused tests confirm the registry/palette and applicable transport operations remain healthy; no further proof task is needed.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|---|---|---|---|
| R1 | Command palette behavior | fn-63.2, fn-63.3 | — |
| R2 | Typed centralized UI actions | fn-63.1, fn-63.3 | — |
| R3 | Help and discoverability | fn-63.2, fn-63.4 | — |
| R4 | Preserve transport safety ownership | fn-63.3 | — |
| R5 | Focused regression proof | fn-63.4 | — |
| R6 | Explicitly reject speculative action bus | — | Product decision recorded by this closure revision. |

## References

- `src/serve/public/lib/workspace-actions.ts:4-225`
- `src/serve/public/components/QuickSwitcher.tsx:318-635`
- `src/serve/public/components/ShortcutHelpModal.tsx:171-236`
- `test/serve/public/components/QuickSwitcher.dom.test.tsx`
- `docs/WEB-UI.md:329`
- `CHANGELOG.md:1005`
