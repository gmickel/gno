# fn-174 unchanged paired study: PASS

The original preregistered gate now passes after the selector fix. All six
preparation cases pass exact guards, all 36 draws are valid on the pinned
claude-sonnet-4-5-20250929 model, and compiled output has no per-case grounded
success or required-evidence regression versus canonical Capsule JSON.
Neither fixtures, scoring, thresholds nor reader instructions changed.

| Case | Original Capsule / compiled | Post-fix Capsule / compiled |
| --- | --- | --- |
| Owner | 3/3 / 3/3 | 3/3 / 3/3 |
| Two sources | 0/3 / 0/3 | 3/3 / 3/3 |
| Polarity | 3/3 / 3/3 | 3/3 / 3/3 |
| Injection | 3/3 / 3/3 | 3/3 / 3/3 |
| Original abstention key | 0/3 / 0/3 | 0/3 / 0/3 |
| Budget pressure | 3/3 / 3/3 | 3/3 / 3/3 |
| Total | 12/18 / 12/18 | 15/18 / 15/18 |

The selector now supplies both security and operations source passages in the
unchanged two-source case. Both formats preserve them and all three reader
repetitions answer correctly with both required citations. All other keyed
outcomes remain unchanged. Exact byte auditing confirms every provided Capsule
evidence text and URI survives compilation in every case.

Determinism, source stale detection, revoked-scope rejection, whole-output
bounds, current verification, absolute required-source inclusion and required
citations pass 6/6 each. Median complete conservative handoff cost is
4,093 -> 1,163.5 tokens/bytes (71.6% lower). The conservative estimator uses
UTF-8 bytes; this is not a model-token or latency claim.

The compiled format is not demonstrated more accurate than the Capsule format:
the paired superiority verdict remains NOT CONFIRMED, with every per-feature
delta zero. The gate tests no regression plus exact guards and lower median
cost, not perfect reader accuracy. The original abstention key still fails
3/3 in BOTH arms and remains included, scored exactly as registered. No result
was invalidated, replaced, dropped or re-keyed to obtain this pass.

A separately preregistered neutral-source missing-fact probe passed all six
draws, including positive and negative contact controls. Its evidence lives
in ../abstention-probe/ and is not pooled into these scores. It supports only
that unambiguous missing-fact example; it does not erase the original negative
results or establish general abstention reliability.

## Evidence and scope

`comparison.json` compares the original failed study against this complete run.
`report.json` is the unchanged reader's decision and item-level scoring.
`prepared.json` contains guards, source identities, omissions, costs and stale
checks. `draws/` retains every prompt, answer, stdout/stderr and usage/model
receipt. No retries, model substitution or incomplete transport draws occurred.

`registration.json` and frozen source copies record the exact selector,
compiler, preparation, reader, fixture and preregistration hashes before draws.
The final comparison verified each file still matched its registered hash.
All original artifacts under fn-169 remain untouched, including the failed
study and original ambiguous question.

This is bounded evidence for the complementary-source fix and explicit manual
compiled-context export. It does not support automatic integration, broader
ranking claims, guaranteed evidence sufficiency under all budgets or a claim
that every reader answer is grounded. The other repository acceptance, privacy,
budget and live-QA gates remain separate requirements owned by the parent run.
