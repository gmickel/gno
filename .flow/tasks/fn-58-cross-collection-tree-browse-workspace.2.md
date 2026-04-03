# fn-58-cross-collection-tree-browse-workspace.2 Build cross-collection tree sidebar UI in Browse

## Description

Build the cross-collection tree sidebar in Browse using repo-native components and existing shadcn/Radix primitives.

Initial slice:

- add a left-rail tree sidebar to `Browse`
- render collection roots and nested folder rows
- support expand/collapse and visible selected-node treatment
- keep the current browse table/detail surface intact on the right
- avoid bringing in a third-party tree dependency unless absolutely necessary
- add interaction tests for the sidebar shell where practical

This task is about the sidebar shell and interaction model, not yet the full selection-driven detail-pane behavior.

## Acceptance

- [ ] Browse shows a real tree sidebar instead of only a collection dropdown
- [ ] Users can expand/collapse collection and folder nodes
- [ ] Selected node is visually obvious and does not look like generic placeholder UI
- [ ] Existing browse content area remains present and usable beside the tree
- [ ] Tree implementation uses existing primitives/components unless a new dependency is explicitly justified
- [ ] Tests are updated for sidebar expand/collapse and selection shell behavior

## Done summary

Shipped the cross-collection tree sidebar UI in Browse. Added a repo-native tree sidebar with expand/collapse, pinned collection integration, visible selection treatment, and keyboard-friendly tree navigation using existing primitives.

## Evidence

- Commits:
- Tests: bun run lint:check, bun run typecheck, bun test, bun run test:e2e, cd website && make sync-docs
- PRs:
