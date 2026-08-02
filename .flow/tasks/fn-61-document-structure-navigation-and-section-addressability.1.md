# fn-61-document-structure-navigation-and-section-addressability.1 Build shared heading extraction and stable section anchor contract

## Description

Create the shared data layer for section-aware navigation.

Initial slice:

- heading extraction
- stable anchor/slug generation
- section-link building helpers
- typed section metadata for UI/API/SDK/MCP parity
- unit coverage for extraction + slug stability

## Acceptance

- [ ] Shared section extraction logic exists outside DocView-only code
- [ ] Anchor generation is stable and tested
- [ ] Typed section metadata is ready for multiple surfaces
- [ ] Tests cover extraction and slug rules

## Done summary
Reconciled as shipped: shared section extraction, duplicate-anchor rules, and fence handling are in main.
## Evidence
- Commits: 7f8706c5, 0db1cd2e, cc513c58, 05eb785f, 2ad51158, 695fbe65
- Tests: bun test test/core/sections.test.ts test/mcp/tools/workspace-write-export.test.ts test/mcp/tools/workspace-write.test.ts test/sdk/client.test.ts test/serve/api-docs-lifecycle.test.ts test/serve/public/components/QuickSwitcher.dom.test.tsx (56 pass)
- PRs: