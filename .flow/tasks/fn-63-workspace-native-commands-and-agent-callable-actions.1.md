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

## Evidence

- Commits:
- Tests:
- PRs:

