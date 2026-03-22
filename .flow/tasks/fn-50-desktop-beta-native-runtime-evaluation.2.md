# fn-50-desktop-beta-native-runtime-evaluation.2 Compare shell candidates against Electrobun gaps

## Description

Use the Electrobun spike results as the baseline and compare at least one other viable shell/runtime candidate against the specific gaps now identified.

Electrobun findings to compare against:

- promising Bun-native shell fit
- packaged app can boot GNO and handle `gno://open?route=...`
- native trash and folder dialog work
- no obvious built-in file association support surfaced in docs/source
- no obvious single-instance guard surfaced in docs/source
- forced second launch (`open -n`) spawns a second shell/server instance

The follow-up should focus on the unresolved decision-makers:

- single-instance guarantees
- open-file/file association support
- updater/signing/distribution path
- how much shell-specific glue GNO would need

## Acceptance

- [ ] Comparison captures Electrobun vs at least one other realistic candidate on the critical gaps.
- [ ] The repo has a documented recommendation for whether Electrobun remains the front-runner or should be dropped.
- [ ] Follow-on work for `fn-51` is explicit instead of implied.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
