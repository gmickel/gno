# fn-169 paired handoff result: FAIL

The preregistered gate failed and remains failed. The compiled arm did not
regress against the existing Capsule arm, but the upstream Capsule omitted
required evidence in one case. This is not a clean R6 quality-gate pass and
must remain visible in delivery/release notes. No automatic integration is
recommended. The manual-only feature scope does not convert this result to PASS.

## Fixed experiment

Six original synthetic held-out tasks, three draws per arm, 36 total. Both arms
used the exact same Capsule evidence and identical reader instructions/questions.
Baseline was canonical Capsule JSON; candidate was compiled Markdown. Each
handoff had a fixed 12,000 conservative-token/byte ceiling. All 36 transports
completed and all response model identities were claude-sonnet-4-5-20250929,
using the cl2 subscription profile. No model substitution or retries occurred.

| Task | Capsule grounded success | Compiled grounded success |
| --- | --- | --- |
| Owner | 3/3 | 3/3 |
| Two sources | 0/3 | 0/3 |
| Polarity | 3/3 | 3/3 |
| Injection | 3/3 | 3/3 |
| Abstention | 0/3 | 0/3 |
| Budget pressure | 3/3 | 3/3 |
| Total | 12/18 | 12/18 |

Per-case and pooled non-regression passed. All corresponding draws agreed;
no question discriminated between formats. evalkit superiority was NOT CONFIRMED
because every difference was zero. Its generic reason text says a feature moved
the wrong way; the actual recorded per-feature deltas are all zero, not negative.
Equality is not superiority and this small suite is not a general accuracy claim.

## Exact guards and retained failures

- Determinism: 6/6 byte-identical repeated compilations.
- Current verification, whole-output bounds and source-stale detection: 6/6 each.
- Revoked collection scope rejected: 6/6.
- Compiler preserved the selected evidence and citations in all six cases;
  compiler omissions were empty in all six. It dropped no provided required
  evidence. No compiler privacy/determinism/preservation guard failed.
- Absolute required-source inclusion and corresponding citation guards: 5/6.
  In `two_sources`, the original Capsule already contains only `security.md`.
  It records `operations.md` as `redundant_coverage`; the renderer cannot supply
  that absent source. Both readers correctly said the combined requirement was
  NOT SPECIFIED from the available evidence, but failed the sealed full-task
  truth and required-citation key. The omission predates compilation.
- Abstention: 0/3 in each arm under the frozen key. Both readers returned
  `Q2: NO` to whether the reimbursement cap was exactly 900 EUR. The source says
  no monetary limit has been decided; the key expected NOT SPECIFIED. **Post-hoc
  instrument concern:** NO is plausibly a defensible reading of that wording.
  This concern does not invalidate, re-key or rescore any draw. A future study
  would need a newly preregistered unambiguous missing-fact question.

## Cost and limits

Median complete handoff conservative cost: 4,093 -> 1,098.5 (73.2% lower).
The recorded unicode_conservative estimator counts UTF-8 bytes. The longer
case was 5,935 -> 2,895; it is modest budget pressure, not near-limit saturation.
All compilers reported no omissions for their already-selected evidence.

Median provider-reported input, including system/CLI framing and cached input:
2,034.5 -> 944 tokens. Total provider input across 18 draws per arm:
37,980 -> 18,050; output totals 6,892 -> 6,039. These are distinct from the
conservative handoff accounting and are not a latency or production cost claim.

The lower-cost endpoint passed, but absolute completeness did not; therefore
`report.json` retains `gatePassed: false`. The paired result supports reduced
packaging cost with no observed relative loss on these fixtures. It does not
establish sufficient context for every task, better retrieval, generalized
abstention reliability, or permission to enable automatic integration.

## Evidence and reproducibility

`prepared.json` contains guard details, source/fixture hashes, both handoff costs,
Capsule identities, omissions, coverage, and stale checks. `report.json` contains
every score, question-level answers, abstention results and comparative signal.
`draws/` retains all 36 prompts, answers, raw stdout/stderr and provider receipts.
`cases.frozen.json`, `preregister.frozen.md`, and `reader.frozen.py` preserve the
exact fixture, decision contract and reader runner used. `reader-manifest.json`
records model/settings/instruction hashes and the evalkit source hash.

Preparation was formatted after materializing the frozen handoffs, before
reader completion; this was whitespace-only and did not regenerate or alter
any Capsule, question, handoff or threshold. The original preparation source
hash is retained in prepared.json. No data-dependent fixture/model/threshold
changes were made. All negative outcomes remain included.

After scoring, fixture JSON was formatted for repository style (parsed data
verified identical to cases.frozen.json). The runner gained overwrite refusal
and nonzero exit on a failed gate; the exact original runner remains frozen.
These operational corrections did not rerun or rescore any draw. A separate
posthoc preservation-audit.json confirms byte-for-byte inclusion of every
provided Capsule evidence text and URI in its compiled artifact.
