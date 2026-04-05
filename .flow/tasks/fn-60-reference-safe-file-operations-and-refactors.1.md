# fn-60-reference-safe-file-operations-and-refactors.1 Define shared refactor planner for editable note file operations

## Description

Build the planning layer before shipping destructive file operations.

Initial slice:

- define a shared refactor planner for rename, move, duplicate, and create-folder flows
- model affected docs, rewriteable refs, warnings, and refusal states
- keep semantics reusable across applicable surfaces
- add unit coverage for planner behavior and edge cases

## Acceptance

- [ ] Shared planner exists outside UI code
- [ ] Planner produces actionable previews/warnings
- [ ] Planner distinguishes safe, risky, and unsupported operations
- [ ] Tests cover rename/move/reference edge cases

## Done summary

## Evidence

- Commits:
- Tests:
- PRs:

