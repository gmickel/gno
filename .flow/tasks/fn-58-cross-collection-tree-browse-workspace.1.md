# fn-58-cross-collection-tree-browse-workspace.1 Add browse tree data model and derivation layer

## Description

Build the tree data/model layer that Browse 2.0 will depend on.

Initial slice:

- derive a normalized cross-collection tree from collections + indexed document paths
- represent collection roots, nested folders, and optional document leaves cleanly
- define stable node ids/keys suitable for selection and expansion state
- keep the model cheap enough to rebuild without pathological cost
- add unit coverage for tree derivation and edge cases
- update task-level docs/spec notes if the derivation contract becomes user-visible or reusable elsewhere

This task should not yet ship the final Browse UI. The goal is a solid model and API boundary for later UI tasks.

## Acceptance

- [ ] Tree derivation can represent multiple collections and nested folders in one unified model
- [ ] Node ids are stable enough for tab-scoped selection/expansion persistence
- [ ] Empty collections, duplicate folder names across collections, and deep paths are covered by tests
- [ ] The output shape is clean enough that later UI tasks do not need to re-think the tree model
- [ ] Tests are updated for tree derivation behavior

## Done summary

Shipped the browse tree model and API foundation. Added a shared tree derivation layer, a dedicated `/api/browse/tree` endpoint, active browse document queries, and tests for tree derivation plus folder-filtered document listing.

## Evidence

- Commits:
- Tests: bun run lint:check, bun run typecheck, bun test, bun run test:e2e, cd website && make sync-docs
- PRs:
