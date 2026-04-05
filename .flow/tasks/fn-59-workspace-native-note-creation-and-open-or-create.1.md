# fn-59-workspace-native-note-creation-and-open-or-create.1 Define shared note-creation resolver and place-aware API contract

## Description

Build the shared semantic core for note creation.

Initial slice:

- define one place-aware creation resolver outside React UI code
- resolve collection, folder, title, slug/file name, and collision policy
- define deterministic open-or-create semantics
- expose the contract through a typed API surface the Web UI can call first and CLI/SDK/MCP can later match exactly
- add unit coverage for path resolution and collision behavior

This task is contract/data-first. It should not yet ship all final UI affordances.

## Acceptance

- [ ] Shared note-creation logic exists outside component handlers
- [ ] Resolver covers current collection, current folder, and explicit target inputs
- [ ] Collision behavior is deterministic and tested
- [ ] API result shape is stable enough to enforce parity across applicable surfaces
- [ ] Tests are updated for core creation semantics

## Done summary

## Evidence

- Commits:
- Tests:
- PRs:
