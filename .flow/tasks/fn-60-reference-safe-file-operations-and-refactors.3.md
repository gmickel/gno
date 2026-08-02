# fn-60-reference-safe-file-operations-and-refactors.3 Add move and create-folder flows to Browse with reference safety

## Description

Bring folder-aware organization into the workspace tree/detail surfaces.

Initial slice:

- create-folder flow in Browse
- move editable note within a collection
- destination picker and preview/warning UI
- automatic post-op refresh/reindex behavior
- tests for move/folder creation behavior

## Acceptance

- [ ] Users can create folders from Browse
- [ ] Users can move editable notes within a collection
- [ ] Move flow surfaces planner warnings where relevant
- [ ] Workspace stays coherent after move/create-folder actions
- [ ] Tests cover move and create-folder flows

## Done summary
Reconciled as shipped: move and folder creation flows, capability checks, indexing refresh, and workspace UI are in main.
## Evidence
- Commits: 7f8706c5, 0db1cd2e, cc513c58, 05eb785f, 2ad51158, 695fbe65
- Tests: bun test test/core/sections.test.ts test/mcp/tools/workspace-write-export.test.ts test/mcp/tools/workspace-write.test.ts test/sdk/client.test.ts test/serve/api-docs-lifecycle.test.ts test/serve/public/components/QuickSwitcher.dom.test.tsx (56 pass)
- PRs: