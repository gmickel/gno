# fn-68-collection-special-docs-and-canonical.2 Surface special docs in collection metadata and UI

## Description

Expose configured special docs in collection metadata and the Web UI.

Requirements:

- collection metadata includes special-doc info
- collections page can surface quick-open affordances for configured docs
- if autodetect exists, UI can suggest rather than silently assume
- UI follows `Scholarly Dusk` conventions

Likely surfaces:

- collection card or detail affordances:
  - `Open home`
  - `Open log`
- maybe subtle badges/labels for configured roles

Do not:

- create a giant dashboard of all special docs
- make this a mandatory workflow
- introduce heavy new navigation chrome

## Acceptance

- [ ] Special docs are visible in collection metadata.
- [ ] Collections UI exposes usable quick-open affordances.
- [ ] UI handles missing/unconfigured docs gracefully.
- [ ] Visual treatment matches existing collection page patterns.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
