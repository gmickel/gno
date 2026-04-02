# fn-57-mac-and-linux-packaging-matrix-and.3 Ship macOS desktop beta artifacts and release workflow

## Description

Turn the macOS desktop-beta release path into something shippable through GitHub release automation.

Use the release-environment/checklist patterns in `~/work/transcribe` as the reference for:

- release environment secrets/vars
- CI stages
- artifact upload
- immutable versioned artifacts
- release-day validation expectations

Scope:

- add or adapt a GitHub Actions workflow for macOS desktop beta release work
- wire the workflow to build the signed/notarized artifact from the release path
- upload desktop beta artifacts to the chosen public distribution surface
- make the release process concrete enough that a tagged release can ship macOS desktop without tribal knowledge
- update rollout/install docs for the chosen artifact path

Do not overreach into a full Sparkle/appcast updater unless GNO actually needs that for beta rollout.

## Acceptance

- [ ] A GitHub Actions workflow or equivalent CI release path exists for macOS desktop beta artifacts.
- [ ] Required release environment secrets/vars are documented.
- [ ] The workflow uploads the chosen macOS desktop beta artifact(s) on release/tag builds.
- [ ] The release docs specify where testers/users download the artifact and what is versioned/immutable.
- [ ] `docs/DESKTOP-BETA-ROLLOUT.md` and related install docs reflect the real macOS beta release path.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
