# fn-61-document-structure-navigation-and-section-addressability.4 Polish section-navigation docs website and end-to-end coverage

## Description

Ship the section-navigation feature set clearly and completely.

Initial slice:

- update docs and website copy for outline/deep-link behavior
- add smoke/e2e coverage where it materially improves confidence
- close UX/documentation gaps discovered during implementation

## Acceptance

- [ ] Docs in `docs/` reflect the final section-navigation behavior
- [ ] Website copy reflects the final section-navigation behavior
- [ ] Smoke/e2e coverage exists where it materially reduces regression risk
- [ ] Epic ships without docs drift

## Done summary
Reconciled as shipped: section documentation and focused core/UI/SDK coverage exist and pass on current main.
## Evidence
- Commits: 7f8706c5, 0db1cd2e, cc513c58, 05eb785f, 2ad51158, 695fbe65
- Tests: bun test test/core/sections.test.ts test/mcp/tools/workspace-write-export.test.ts test/mcp/tools/workspace-write.test.ts test/sdk/client.test.ts test/serve/api-docs-lifecycle.test.ts test/serve/public/components/QuickSwitcher.dom.test.tsx (56 pass)
- PRs: