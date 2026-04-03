# fn-58-cross-collection-tree-browse-workspace.4 Persist tab-scoped browse tree state and restore deep-link context

## Description

Extend workspace-tab persistence so each tab can retain its own Browse tree session state.

Initial slice:

- persist selected browse node per tab
- persist expanded tree nodes per tab
- restore that state when switching tabs or reopening the workspace
- reconcile tab state with URL/deep-link browse entry points without creating a confusing second navigation system
- keep fallback behavior sane when nodes disappear after reindexing or collection removal
- add/extend restore-state tests around workspace tabs + browse context

This is what makes tree browse compose with the existing app-level tab model instead of fighting it.

## Acceptance

- [ ] Browse tree selection restores per tab
- [ ] Expanded nodes restore per tab
- [ ] Refresh/deep-link entry still produces a useful browse context
- [ ] Missing/stale nodes fail gracefully instead of breaking browse state
- [ ] Workspace-tab persistence remains coherent rather than becoming a pile of browse-specific exceptions
- [ ] Tests are updated for per-tab restore and stale-node fallback behavior

## Done summary

Shipped tab-scoped browse state restore. Workspace tabs now persist browse expansion metadata, Browse restores ancestor expansion from URL + tab state, and tab labels reflect collection/folder browse context.

## Evidence

- Commits:
- Tests: bun run lint:check, bun run typecheck, bun test, bun run test:e2e, cd website && make sync-docs
- PRs:
