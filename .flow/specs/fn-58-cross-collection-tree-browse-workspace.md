# fn-58-cross-collection-tree-browse-workspace Cross-Collection Tree Browse Workspace

## Overview

Turn Browse into a real workspace navigator: a cross-collection tree in the left rail, a folder/detail pane on the right, and tab-scoped browse state so each tab can hold its own navigation context.

This should push GNO closer to the "live in it all day" bar that Obsidian clears today, without copying Obsidian wholesale or replacing GNO's stronger search-first strengths.

## Prior Context

- `fn-45-desktop-beta-workspace-navigation` established recents, favorites, pinned collections, and a more serious quick-switcher/navigation model.
- `fn-53-desktop-beta-app-level-tabs-and-multi` established app-level tabs. Browse should now take advantage of tabs rather than acting like a stateless route with only URL params.
- The current `Browse` page is still mostly a collection filter + flat table. It works for query-first retrieval, but not for place-first navigation or spatial memory.
- `docs/` remains the source of truth. If this changes navigation behavior, update docs and website in the same implementation.

## Why now

- Browse is the main gap between "great local search tool" and "real daily-driver note workspace."
- A tree gives users folder/collection orientation, not just result lists.
- Tabs already exist, so there is now a good place to preserve per-context browse state.
- This is one of the clearest product upgrades that makes GNO feel like a contender to Obsidian for actual day-to-day use.

## Difficulty

Medium to hard.

## Start Here

- `src/serve/public/pages/Browse.tsx`
- `src/serve/public/app.tsx`
- `src/serve/public/components/WorkspaceTabs.tsx`
- `src/serve/public/lib/workspace-tabs.ts`
- `src/serve/routes/api.ts`
- `src/store/sqlite/adapter.ts`
- `docs/WEB-UI.md`
- `website/features/web-ui.md`

## Scope

- cross-collection tree sidebar in Browse
- folder expansion/collapse and selection
- collection roots plus nested folders beneath each collection
- main pane that shows current folder contents / collection contents
- preserve current flat-table strengths where they still help
- tab-scoped browse state:
  - selected collection/folder/node
  - expanded nodes
  - tree width / pane layout if implemented
- URL/deep-link behavior for browse navigation where practical
- docs updates for the new browse model
- website updates for the new browse model
- test updates for the new browse model

## Explicit Non-goals

- drag-and-drop reordering or file moves
- rename/trash/create flows inside the tree on first pass
- cloning Obsidian's exact UI structure or plugin-driven behavior
- replacing search / quick-switcher as primary retrieval surfaces
- multi-window shell behavior

## Product Stance

- Keep Browse query-aware, but make it place-aware.
- Do not replace the current table with a giant always-open tree.
- Tree is primary navigation; detail pane remains the place for sorting, selection, and richer document metadata.
- Tabs should not duplicate UI chrome. The same Browse UI should exist in every tab, but each tab should retain its own browse session state.

## Requirements

- Users can browse all collections from one unified tree without first picking a collection from a dropdown.
- Each collection appears as a root node with nested folder nodes derived from indexed document paths.
- First pass may keep document leaves optional:
  - either folder-only tree + folder contents pane
  - or folder tree with expandable document leaves
- Browse state is tab-scoped, not globally shared:
  - switching tabs restores the selected browse node and expansions for that tab
- URL behavior remains predictable:
  - refresh/share deep-links should still restore enough browse context to be useful
- Favorites/pinned collections from `fn-45` should compose cleanly with the new tree instead of being discarded
- Search, quick-switcher, and direct doc links must still coexist with Browse as separate navigation paths
- Accessibility baseline:
  - keyboard traversal
  - visible selection
  - expand/collapse semantics
  - screen-reader labels/roles where appropriate
- Preserve performance on large workspaces:
  - avoid rebuilding the whole tree expensively on every render
  - avoid pathological expansion state churn
  - be mindful of large collection counts / deep folders

## UX Deliverables

- Browse 2-pane layout:
  - left: tree / pinned collections / maybe recents entry points
  - right: folder contents / current node detail pane
- Clear selected-node visual treatment
- Expand/collapse affordances that feel deliberate, not generic slop
- Good empty states:
  - no collections
  - empty folder
  - collection exists but nothing indexed yet
- Mobile fallback may degrade to collapsible drawer/tree instead of permanent sidebar

## Technical Deliverables

- API or local transformation layer that can produce a tree model from indexed docs/collections
- tab-aware browse state model extending current workspace-tab state
- reusable tree component(s) built from existing primitives where possible
- tests for:
  - tree model derivation
  - selection/expansion behavior
  - tab-scoped restore behavior
  - Browse interaction smoke coverage
- docs updates in `docs/`
- website updates for any user-facing navigation copy or feature pages impacted
- test updates covering tree model, interaction, and restored-state behavior

## Component Strategy

Use existing shadcn/Radix primitives first:

- `Collapsible`
- `ScrollArea`
- `Separator`
- `ContextMenu` / `DropdownMenu` later if needed
- existing tab/workspace state primitives

Do not add an external tree-view dependency by default. First preference:

- compose a repo-native tree row component and tree state model
- only introduce a third-party tree library if keyboard/tree semantics become disproportionately expensive or accessibility is clearly worse than a proven library

## Approach

1. Add a normalized tree model for collections/folders from current indexed docs.
2. Refactor `Browse` into tree + detail pane.
3. Extend workspace-tab persistence to remember browse session state per tab.
4. Restore tree state on tab switch and page refresh/deep-link entry.
5. Add keyboard/accessibility coverage and docs.

## Dependencies

- Blocked by: `fn-45-desktop-beta-workspace-navigation`, `fn-53-desktop-beta-app-level-tabs-and-multi`
- This epic should build on existing tabs and favorites, not replace them.

## Risks / Design Traps

- giant tree with poor perf on large note sets
- state split between URL, global app state, and per-tab state in confusing ways
- browse becoming an Obsidian imitation instead of a GNO-native navigation surface
- over-building file-management actions before the navigation model itself feels solid

## Quick commands

<!-- Required: at least one smoke command for the repo -->

- `bun test`
- `bun run test:web`
- `bun run lint:check`

## Acceptance

- [ ] Browse supports a real cross-collection tree sidebar.
- [ ] Users can navigate folders across all collections without relying on the collection dropdown alone.
- [ ] Browse state restores per tab instead of collapsing into one global browse context.
- [ ] Existing table/detail affordances remain usable in the new model.
- [ ] Keyboard/selection/expand-collapse behavior has first-pass accessibility coverage.
- [ ] Docs and website reflect the new browse workspace behavior.
- [ ] Tests are updated for the new browse tree model and interaction behavior.

## References

- `.flow/specs/fn-45-desktop-beta-workspace-navigation.md`
- `.flow/specs/fn-53-desktop-beta-app-level-tabs-and-multi.md`
- `src/serve/public/pages/Browse.tsx`
- `src/serve/public/lib/workspace-tabs.ts`
