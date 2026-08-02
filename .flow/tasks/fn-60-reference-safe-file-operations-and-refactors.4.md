# fn-60-reference-safe-file-operations-and-refactors.4 Polish file-op docs website and end-to-end safety coverage

## Description

Close the epic with full user-facing clarity.

Initial slice:

- update docs and website for file ops / safety semantics
- add smoke/e2e coverage for rename/move/folder actions where practical
- ensure read-only file refusal semantics are documented and tested

## Acceptance

- [ ] Docs in `docs/` reflect file-op behavior and safety semantics
- [ ] Website copy reflects file-op behavior and safety semantics
- [ ] Smoke/e2e coverage exists for the primary editable-note file ops
- [ ] Epic ships without docs drift

## Done summary
Reconciled as shipped: focused lifecycle, SDK, MCP, UI, and documentation coverage exists and passes on current main.
## Evidence
- Commits: 7f8706c5, 0db1cd2e, cc513c58, 05eb785f, 2ad51158, 695fbe65
- Tests: bun test test/core/sections.test.ts test/mcp/tools/workspace-write-export.test.ts test/mcp/tools/workspace-write.test.ts test/sdk/client.test.ts test/serve/api-docs-lifecycle.test.ts test/serve/public/components/QuickSwitcher.dom.test.tsx (56 pass)
- PRs: