# fn-59-workspace-native-note-creation-and-open-or-create.3 Unify quick-switcher open-or-create and wiki-link create semantics

## Description

Bring the existing fast-entry surfaces onto the same creation semantics.

Initial slice:

- upgrade quick-switcher to a real open-or-create flow using the shared resolver
- align wiki-link create behavior with the same path/collision semantics
- preserve current speed/discoverability instead of making these paths heavier
- add tests proving quick-switcher and wiki-link creation no longer diverge

## Acceptance

- [ ] Quick-switcher and wiki-link creation use the same creation semantics
- [ ] Open-or-create behavior is deterministic
- [ ] Current collection/folder defaults are preserved where appropriate
- [ ] Tests cover parity between quick-switcher and wiki-link create flows

## Done summary

## Evidence

- Commits:
- Tests:
- PRs:

