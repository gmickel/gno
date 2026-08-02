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
Reconciled as shipped: shared browser-safe file-operation planners and warning summaries are in main.
## Evidence
- Commits: 7f8706c5, 0db1cd2e, cc513c58, 05eb785f, 2ad51158, 695fbe65
- Tests: bun test test/core/sections.test.ts test/mcp/tools/workspace-write-export.test.ts test/mcp/tools/workspace-write.test.ts test/sdk/client.test.ts test/serve/api-docs-lifecycle.test.ts test/serve/public/components/QuickSwitcher.dom.test.tsx (56 pass)
- PRs: