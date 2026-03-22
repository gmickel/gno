# fn-50-desktop-beta-native-runtime-evaluation.2 Compare shell candidates against Electrobun gaps

## Description

Electrobun is now the working direction for the desktop beta. This task is fallback work, not the primary path.

Only execute a broader shell comparison if Electrobun still fails a must-have capability after the focused validation work in `fn-50`:

- no acceptable `open-file` / file-association path
- no acceptable distribution/signing path
- unacceptable shell glue or maintenance cost

If triggered, compare Electrobun against at least one realistic fallback on the exact unresolved gaps.
If not triggered, this task should be marked not-needed/blocked by the Electrobun go decision rather than consuming roadmap time by default.

## Acceptance

- [ ] Comparison only happens if Electrobun fails a must-have gate.
- [ ] Any comparison is scoped to the unresolved gaps, not a generic framework tour.
- [ ] The repo records whether this task was needed or explicitly skipped due to the Electrobun decision.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
