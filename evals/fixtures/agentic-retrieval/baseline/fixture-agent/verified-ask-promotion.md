# Verified Ask promotion

Canonical fingerprint: `abcd681a0cf9dcb28fa00db1b484a83907987f25e99d4fd4f95166b1a33d92cc`

Verdict: **PASS**

- Cohort: 22 paired tasks
- Baseline: production raw Ask
- Candidate: production `buildVerifiedAsk`
- Answer accuracy (raw/verified): 0.8181818181818182 / 0.8181818181818182
- Unsupported substantive claims (raw/verified): 4 / 0
- Unsupported-claim reduction: 1
- Excluded: t234cd5e (expected_missing_evidence), t345de6f (expected_missing_evidence)
- Failures: none

## Methodology

- Production raw Ask (searchHybrid, generateGroundedAnswer, processAnswerResult) is the baseline.
- Production buildVerifiedAsk with closed-Capsule semantic claim verification is the candidate.
- Both lanes share one immutable fixture index, task goal, collection, search modes, deterministic answer agent, model fingerprint, and declared draft.
- The compatible cohort is deterministic: exactly one required substantive claim and no expected-missing/abstention case.
- Four fixed adversarial drafts test whether unsupported substantive claims escape the product boundary; this is enforcement evidence, not a model-quality claim.
- Promotion requires no pairwise or aggregate answer-accuracy regression and strictly fewer unsupported substantive claims.
