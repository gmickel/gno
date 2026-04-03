# fn-58-cross-collection-tree-browse-workspace.5 Polish accessibility, mobile fallback, tests, and docs for Browse 2.0

## Description

Finish Browse 2.0 so it can actually ship.

Initial slice:

- add first-pass keyboard and accessibility coverage for the tree
- add mobile fallback behavior for the sidebar/tree
- tighten selection/focus/expand-collapse interactions
- add DOM/browser coverage for the new browse interactions
- update docs/website copy to describe the new browse workspace model
- sync any website/docs mirrors required by the repo workflow

This task is the polish/gate task that turns the previous implementation slices into a finished product behavior.

## Acceptance

- [ ] Tree navigation has first-pass keyboard and accessibility coverage
- [ ] Browse remains usable on mobile/smaller screens
- [ ] Tests cover the core tree interaction path and at least one restored-state path
- [ ] Docs/website reflect Browse 2.0 accurately
- [ ] The overall browse workspace feels shippable, not just technically complete
- [ ] Final docs, website, and test updates are included in the ship-ready slice

## Done summary

Shipped Browse 2.0 polish. Added DOM and API coverage for the new tree interactions, expanded the browser smoke path to include Browse, and updated docs/website copy for the cross-collection tree workspace.

## Evidence

- Commits:
- Tests: bun run lint:check, bun run typecheck, bun test, bun run test:e2e, cd website && make sync-docs
- PRs:
