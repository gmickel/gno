# fn-68-collection-special-docs-and-canonical.1 Design special-doc config and detection rules

## Description

Design the config and autodetection model for collection special docs.

Requirements:

- explicit per-collection config shape
- optional autodetect suggestions for common names
- explicit precedence rules:
  - config wins
  - autodetect suggests only
- names must stay generic enough for different workflows

Cover:

- candidate role names:
  - `home`
  - `log`
  - maybe `inbox`
  - maybe `outputs`
- how relative paths are resolved within collection roots
- whether nested paths are allowed
- how invalid/missing files are surfaced

Do not:

- hardcode `_index.md` and `log.md` as the only valid choices
- require all roles
- add write/mutation commands in this task

## Acceptance

- [ ] Config shape is concrete.
- [ ] Autodetect suggestions are concrete.
- [ ] Precedence is explicit.
- [ ] The proposal is generic, not overfit to one personal vault.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
