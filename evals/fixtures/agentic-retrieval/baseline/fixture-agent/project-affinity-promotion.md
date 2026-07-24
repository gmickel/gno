# Project-affinity promotion

Verdict: **PASS**
Target correct top-1 (disabled/enabled): 0/2
Evidence accuracy/coverage loss: 0/0
Multilingual loss: 0
Hard filter: PASS
Zero lanes: PASS
Structural calls: PASS
Failures: none

## Methodology

- Separate deterministic fn-97 lane; the authoritative 24-task adapter matrix is unchanged.
- Two controlled vector-distance pairs make the oracle collection lose by 0.02 before one trusted local +0.03 contribution.
- All 24 tasks run with their existing hard collection; the gate requires zero URI-rank and required-evidence coverage loss.
- Store calls are instrumented structurally; wall-clock latency is not a gate.

## Limitations

- Controlled vector distances isolate the bounded promotion seam; they do not claim general retrieval superiority.
- The fixture agent still selects hard collections and MCP project hints remain untrusted zero-affinity inputs.
- Results apply only to this closed synthetic corpus and exact committed identities.
