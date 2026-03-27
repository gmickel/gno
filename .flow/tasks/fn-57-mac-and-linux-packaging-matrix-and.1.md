# fn-57-mac-and-linux-packaging-matrix-and.1 Define packaging targets and support tiers by platform

## Description

Define the packaging/support matrix for macOS and Linux.

This is the decision-making task that turns the current hand-wavy packaging conversation into an explicit product/support contract. It should answer what is shipped for CLI vs desktop, what is supported vs beta vs experimental, and what runtime pieces must be bundled for each platform.

Focus on:

- mac desktop support target
- mac CLI distribution target
- linux CLI support target
- linux desktop support target
- architecture and distro boundaries
- runtime bundling assumptions for SQLite + extensions

## Acceptance

- [ ] Platform matrix is written down for macOS and Linux.
- [ ] CLI and desktop are treated as separate support surfaces.
- [ ] Artifact recommendations are explicit.
- [ ] Runtime dependency assumptions are explicit.
- [ ] Result is concrete enough to drive docs and release work.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
