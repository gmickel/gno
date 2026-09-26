# Diagnose native retrieval acceptance instability

## Goal

Restore a valid, non-regressing cached-model evidence screen before considering a noExpand retrieval-policy change.

## Observed behavior

The frozen screen on both revisions 65ebd81a and the fn-174 selector correction reports `held_out_regression:missing-policy` for noExpand against current retrieval. Both retain the same service-owner miss. The post-correction run also records an expansion inference failure on exact-code; that run is invalid. The pre-correction run is valid but fails the policy comparison. These failures do not establish a selector regression; the native screen exercises ordinary query retrieval, while the separately frozen Capsule handoff comparison passes after the correction.

## Requirements

Reproduce with the unchanged evidence fixtures, cached model hashes and reader settings. Diagnose the missing-policy answer/abstention difference and the expansion failure independently. Preserve all negative reports and do not lower thresholds, regenerate fixtures or silently substitute models. Do not enable noExpand by default based on a failed comparison. Keep any runtime fix minimal and run affected tests and native evidence gates. Update Git and gno.sh documentation only for supported behavior changes.

## Evidence

See `.flow/artifacts/fn-174-preserve-complementary-capsule-evidence/native/` for reports and source identities; retained raw run directories are named in the comparison receipt.

## Findings (2026-09-26)

Reproduced on CUDA (RTX 4090) with the unchanged fixtures (`fixtureSha256` 32ed84ea…), cached model hashes, and reader settings. Reports are in `.flow/artifacts/fn-175-diagnose-native-retrieval-acceptance/native/`.

**missing-policy is a real noExpand regression, not instability.** The case asks for a 2027 migration date that no fixture document contains. Both arms deliver the same eight irrelevant notes in a different order. The current arm abstains; the noExpand arm answers "120" (from the September quota note). This was identical in all six native runs (fn-174 before and after, and runs 1-5 here), so the fixed reader is deterministic for this input. The screen is correct to fail the noExpand comparison. noExpand stays off; no threshold, fixture, or model change.

**The invalid run was a product bug: the five-second expansion budget.** `expandQuery` had its own 5 s budget covering model load and generation. The f16 expansion model (3.4 GB) loads in about 2.8 s cold on CUDA, so the first case intermittently exceeded the budget; the capture recorded `MODEL_LOAD_FAILED` caused by "Inference cancelled" (run 1; fn-174 after-run). On CPU the budget always failed: measured warm generation was 15.0-21.7 s (cold 17.9 s), so CPU users never received expansion.

Fix (78506ddc): expansion has no budget of its own. The model load runs under `models.loadTimeout` and generation under `models.inferenceTimeout`, like other model calls. Generation runs inside `withInferencePage`, so an inference timeout fails only expansion (graceful null) instead of the request; caller cancellation and deadlines still throw. With the fix, product `expandQuery` on CPU returned expansions in 11.4 s and 7.0 s, and runs 3, 4 and 5 were all valid with the same outcomes as above.

**Known baseline miss, unchanged:** service-owner. Both arms deliver the owner and role notes; the fixed reader returns only "Lina Mora" without "platform engineering lead". It is identical in both arms and does not affect the comparison.
