# fn-63-workspace-native-commands-and-agent-callable-actions.3 Wire core workspace actions into the palette and expose parity-ready command semantics

## Description

Make the command system actually useful.

Initial slice:

- wire representative actions from epics 59-62 into the command palette
- enforce context-aware gating
- keep action semantics ready for CLI/SDK/MCP parity where applicable
- add focused tests for execution behavior

## Acceptance

- [ ] Core workspace actions are executable from the command palette
- [ ] Context-required commands fail/disable cleanly
- [ ] Action semantics stay aligned with the shared action registry
- [ ] Tests cover representative command execution paths

## Done summary
Reconciled as shipped: core note, folder, navigation, and refactor actions are wired through the palette with direct API/SDK/MCP operations where applicable.
## Evidence
- Commits: 7f8706c5, 0db1cd2e, cc513c58, 05eb785f, 2ad51158, 695fbe65
- Tests: bun test test/core/sections.test.ts test/mcp/tools/workspace-write-export.test.ts test/mcp/tools/workspace-write.test.ts test/sdk/client.test.ts test/serve/api-docs-lifecycle.test.ts test/serve/public/components/QuickSwitcher.dom.test.tsx (56 pass)
- PRs: