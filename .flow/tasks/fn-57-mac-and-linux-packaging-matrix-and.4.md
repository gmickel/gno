# fn-57-mac-and-linux-packaging-matrix-and.4 Validate macOS desktop beta on clean-machine checklist

## Description
Create the operational validation pass for the macOS desktop beta after the build/release path exists.

Use the clean-machine notarized-release validation patterns in `~/work/transcribe` as the model, but adapt them to GNO's desktop shell and local-runtime behavior.

Scope:
- define a macOS desktop-beta validation checklist
- include installation from the shipped artifact, not from a local app bundle
- verify first-run onboarding, add-folder flow, indexing, search, presets, deep links, singleton handoff, and file actions
- verify Gatekeeper/notarization acceptance on a clean machine or clean-user-path install
- record rollback/support expectations for a failed beta
## Acceptance
- [ ] A macOS desktop-beta manual QA / clean-install checklist exists in-repo.
- [ ] The checklist validates the shipped artifact, not just source checkout behavior.
- [ ] The checklist includes Gatekeeper/notarization validation steps.
- [ ] The checklist covers core desktop flows: onboarding, indexing, search, presets, deep links, and second-launch handoff.
- [ ] The rollout doc includes explicit rollback/support notes for beta failures.
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
