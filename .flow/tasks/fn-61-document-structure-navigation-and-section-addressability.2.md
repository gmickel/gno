# fn-61-document-structure-navigation-and-section-addressability.2 Add outline pane and section navigation to DocView

## Description

Use the shared section layer in the workspace reading surface.

Initial slice:

- outline/heading navigator UI
- jump to section
- current-section highlight where practical
- empty-state handling for docs without headings
- DOM coverage for section navigation

## Acceptance

- [ ] DocView exposes a usable outline/section navigator
- [ ] Users can jump quickly to sections
- [ ] UI follows the Scholarly Dusk ADR
- [ ] Tests cover primary section-navigation flows

## Done summary
Reconciled as shipped: DocView outline, current-section tracking, and section navigation are in main.
## Evidence
- Commits: 7f8706c5, 0db1cd2e, cc513c58, 05eb785f, 2ad51158, 695fbe65
- Tests: bun test test/core/sections.test.ts test/mcp/tools/workspace-write-export.test.ts test/mcp/tools/workspace-write.test.ts test/sdk/client.test.ts test/serve/api-docs-lifecycle.test.ts test/serve/public/components/QuickSwitcher.dom.test.tsx (56 pass)
- PRs: