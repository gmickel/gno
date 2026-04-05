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

## Evidence

- Commits:
- Tests:
- PRs:

