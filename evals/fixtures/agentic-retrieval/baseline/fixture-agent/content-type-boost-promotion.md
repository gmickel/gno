# Content-type search-boost promotion

Verdict: **PASS**
fn-97 receipts: 24
Exact before/after receipts: PASS
Evidence accuracy (before/after/loss): 24/24/0
Evidence coverage (before/after/loss): 25/25/0
Failures: none

## Methodology

- The authoritative fn-97 24-task production retrieval receipts are replayed through the shipped content-type ranking seam with no configured rules.
- Each before/after receipt freezes ordered result URIs and required-evidence retention; all hashes must remain byte-identical.
- Active positive, negative, tie, keyword-stuffing, filter, conflicting-metadata, and affinity-composition behavior is gated separately by deterministic adversarial tests.

## Limitations

- The fn-97 corpus has no configured content-type rules, so this lane proves backward-compatible zero-regression behavior rather than active-rule quality gains.
- The active-rule suite uses controlled scores to isolate the bounded ranking contract; it does not claim general retrieval superiority.
- Egress policy is not yet an available retrieval capability; no egress-bypass claim is made.
