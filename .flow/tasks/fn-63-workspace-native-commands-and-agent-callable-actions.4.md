# fn-63-workspace-native-commands-and-agent-callable-actions.4 Polish command-system docs website help discoverability and end-to-end coverage

## Description

Close the loop on discoverability and product communication.

Initial slice:

- update docs and website for the final command/action model
- update the `?` help surface documentation
- add smoke/e2e coverage where it materially improves confidence
- close UX/documentation gaps found during implementation

## Acceptance

- [ ] Docs in `docs/` reflect the command/action model
- [ ] Website copy reflects the command/action model
- [ ] `?` help surface is documented and accurate
- [ ] Smoke/e2e coverage exists where it materially reduces regression risk

## Done summary
Reconciled as shipped: command-palette help, docs, and focused DOM/API/SDK/MCP coverage exist and pass on current main.
## Evidence
- Commits: 7f8706c5, 0db1cd2e, cc513c58, 05eb785f, 2ad51158, 695fbe65
- Tests: bun test test/core/sections.test.ts test/mcp/tools/workspace-write-export.test.ts test/mcp/tools/workspace-write.test.ts test/sdk/client.test.ts test/serve/api-docs-lifecycle.test.ts test/serve/public/components/QuickSwitcher.dom.test.tsx (56 pass)
- PRs: