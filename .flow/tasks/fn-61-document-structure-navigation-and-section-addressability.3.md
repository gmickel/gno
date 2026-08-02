# fn-61-document-structure-navigation-and-section-addressability.3 Ship section deep links and copy-link actions across document surfaces

## Description

Make section addressability practical, not just visible.

Initial slice:

- copy deep link to section
- open section links reliably
- section-aware command hooks where relevant
- tests for deep-link behavior and section targeting

## Acceptance

- [ ] Users can copy deep links to sections
- [ ] Section links reopen correctly
- [ ] Section addressability works beyond a single rendered view
- [ ] Tests cover deep-link behavior

## Done summary
Reconciled as shipped: section deep links, copy-link actions, API endpoint, QuickSwitcher navigation, and SDK getSections are in main.
## Evidence
- Commits: 7f8706c5, 0db1cd2e, cc513c58, 05eb785f, 2ad51158, 695fbe65
- Tests: bun test test/core/sections.test.ts test/mcp/tools/workspace-write-export.test.ts test/mcp/tools/workspace-write.test.ts test/sdk/client.test.ts test/serve/api-docs-lifecycle.test.ts test/serve/public/components/QuickSwitcher.dom.test.tsx (56 pass)
- PRs: