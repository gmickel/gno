# fn-58-cross-collection-tree-browse-workspace.3 Integrate folder detail pane and selection-driven browse contents

## Description

Make Browse selection-driven instead of collection-dropdown-driven.

Initial slice:

- wire selected tree nodes into the main detail pane
- show folder contents / collection contents for the current node
- preserve useful table affordances:
  - sorting
  - document count
  - open doc
  - favorite/pin actions where they still make sense
- replace or demote the current dropdown-only mental model
- handle empty states for empty folder / empty collection / no indexed docs
- update user-facing docs/website copy if Browse semantics or screenshots/copy need revision

This is the task that makes the tree actually useful rather than decorative.

## Acceptance

- [ ] Selecting a tree node updates the main pane predictably
- [ ] Users can browse folder contents without relying on the collection dropdown alone
- [ ] Existing flat-table affordances still work within the new browse model
- [ ] Empty states are clear for empty folder and empty collection cases
- [ ] Browse feels like a real navigator, not just the old page with a tree bolted on
- [ ] Docs/website are updated for the new Browse interaction model if behavior changes are user-visible
- [ ] Tests are updated for selection-driven Browse contents behavior

## Done summary

Shipped selection-driven Browse contents. Browse now uses the selected collection/folder node to drive the detail pane, child-folder cards, direct-document table, breadcrumbs, and folder/collection empty states.

## Evidence

- Commits:
- Tests: bun run lint:check, bun run typecheck, bun test, bun run test:e2e, cd website && make sync-docs
- PRs:
