# fn-63-workspace-native-commands-and-agent-callable-actions.2 Evolve quick-switcher into a command palette and integrate the existing help surface

## Description

Build the UI surface on top of the shared action model.

Initial slice:

- evolve quick-switcher into grouped command/action palette
- keep recents/favorites strengths
- integrate with the existing `?` help/shortcuts surface for discoverability
- follow Scholarly Dusk interaction/visual language
- add DOM coverage for palette behavior

## Acceptance

- [ ] Quick-switcher becomes a true command palette
- [ ] Existing `?` help surface remains aligned with command discoverability
- [ ] UI follows the Scholarly Dusk ADR
- [ ] Tests cover palette behavior and help-surface integration

## Done summary
Reconciled as shipped: QuickSwitcher is a command palette and the keyboard-help surface exposes its commands.
## Evidence
- Commits: 7f8706c5, 0db1cd2e, cc513c58, 05eb785f, 2ad51158, 695fbe65
- Tests: bun test test/core/sections.test.ts test/mcp/tools/workspace-write-export.test.ts test/mcp/tools/workspace-write.test.ts test/sdk/client.test.ts test/serve/api-docs-lifecycle.test.ts test/serve/public/components/QuickSwitcher.dom.test.tsx (56 pass)
- PRs: