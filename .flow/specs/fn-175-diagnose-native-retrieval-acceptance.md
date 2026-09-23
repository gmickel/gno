# Diagnose native retrieval acceptance instability

## Goal

Restore a valid, non-regressing cached-model evidence screen before considering a noExpand retrieval-policy change.

## Observed behavior

The frozen screen on both revisions 65ebd81a and the fn-174 selector correction reports `held_out_regression:missing-policy` for noExpand against current retrieval. Both retain the same service-owner miss. The post-correction run also records an expansion inference failure on exact-code; that run is invalid. The pre-correction run is valid but fails the policy comparison. These failures do not establish a selector regression; the native screen exercises ordinary query retrieval, while the separately frozen Capsule handoff comparison passes after the correction.

## Requirements

Reproduce with the unchanged evidence fixtures, cached model hashes and reader settings. Diagnose the missing-policy answer/abstention difference and the expansion failure independently. Preserve all negative reports and do not lower thresholds, regenerate fixtures or silently substitute models. Do not enable noExpand by default based on a failed comparison. Keep any runtime fix minimal and run affected tests and native evidence gates. Update Git and gno.sh documentation only for supported behavior changes.

## Evidence

See `.flow/artifacts/fn-174-preserve-complementary-capsule-evidence/native/` for reports and source identities; retained raw run directories are named in the comparison receipt.
