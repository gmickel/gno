# fn-63-workspace-native-commands-and-agent-callable-actions.1 Define typed workspace action registry and context model

## Description

Create the semantic core before redesigning the command palette.

Initial slice:

- typed action registry
- context model for active tab, browse location, current doc, and current section
- executor contract for applicable UI/CLI/SDK/MCP parity
- tests for action registration, gating, and result shapes

## Acceptance

- [ ] Shared action registry exists outside palette-only UI code
- [ ] Context model covers the core workspace state needed by commands
- [ ] Result semantics are typed and stable
- [ ] Tests cover registration and context gating basics

## Done summary
Reconciled as shipped: typed UI workspace action IDs, descriptors, context gating, and executor are in main.
## Evidence
- Commits: 7f8706c5, 0db1cd2e, cc513c58, 05eb785f, 2ad51158, 695fbe65
- Tests: bun test test/core/sections.test.ts test/mcp/tools/workspace-write-export.test.ts test/mcp/tools/workspace-write.test.ts test/sdk/client.test.ts test/serve/api-docs-lifecycle.test.ts test/serve/public/components/QuickSwitcher.dom.test.tsx (56 pass)
- PRs: