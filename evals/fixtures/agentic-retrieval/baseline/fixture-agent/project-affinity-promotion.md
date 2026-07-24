# Project-affinity promotion

Verdict: **PASS**
Target correct top-1 (disabled/enabled): 0/2
Evidence accuracy/coverage loss: 0/0
Multilingual loss: 0
Hard filter: PASS
Zero lanes: PASS
Structural calls: PASS
Regression tasks: 24; evidence accuracy 24/24; coverage 25/25
Multilingual: 4/4 across 4
Failures: none

## Methodology

- Separate deterministic fn-97 lane; the authoritative 24-task adapter matrix is unchanged.
- Two controlled vector-distance pairs make the oracle collection lose by 0.02 before one trusted local +0.03 contribution.
- All 24 tasks run with their existing hard collection; the gate requires zero URI-rank and required-evidence coverage loss.
- Store calls are instrumented structurally; wall-clock latency is not a gate.

## Raw bounded receipts

- Auxiliary `project_match`: requested 0.03, applied 0.03, final 0.53
- Auxiliary `combined_exact_cap`: requested 0.08, applied 0.08, final 0.58
- Auxiliary `positive_over_cap`: requested 0.11, applied 0.08, final 0.58
- Auxiliary `negative_over_cap`: requested -0.13, applied -0.08, final 0.42
- Auxiliary `overlap_no_stack`: requested 0.03, applied 0.03, final 0.53
- Zero `absent`: equal (`8c84612e784a0bbe6837ceb887c0c1a40e4566c8fb9a73c0c31f0271fcd2d357` / `8c84612e784a0bbe6837ceb887c0c1a40e4566c8fb9a73c0c31f0271fcd2d357`)
- Zero `disabled`: equal (`8c84612e784a0bbe6837ceb887c0c1a40e4566c8fb9a73c0c31f0271fcd2d357` / `8c84612e784a0bbe6837ceb887c0c1a40e4566c8fb9a73c0c31f0271fcd2d357`)
- Zero `unavailable`: equal (`8c84612e784a0bbe6837ceb887c0c1a40e4566c8fb9a73c0c31f0271fcd2d357` / `8c84612e784a0bbe6837ceb887c0c1a40e4566c8fb9a73c0c31f0271fcd2d357`)
- Zero `untrusted_remote`: equal (`8c84612e784a0bbe6837ceb887c0c1a40e4566c8fb9a73c0c31f0271fcd2d357` / `8c84612e784a0bbe6837ceb887c0c1a40e4566c8fb9a73c0c31f0271fcd2d357`)
- Structural `pa-t456ef70:disabled`: candidates 2/2, limit 2, bound 6, calls docs/chunks/collections/list 1/1/1/0
- Structural `pa-t456ef70:enabled`: candidates 2/6, limit 2, bound 6, calls docs/chunks/collections/list 1/1/1/0
- Structural `pa-t567f081:disabled`: candidates 2/2, limit 2, bound 6, calls docs/chunks/collections/list 1/1/1/0
- Structural `pa-t567f081:enabled`: candidates 2/6, limit 2, bound 6, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t012ab3c:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t012ab3c:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t0a1b2c3:disabled`: candidates 2/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t0a1b2c3:enabled`: candidates 2/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t123bc4d:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t123bc4d:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t1b2c3d4:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t1b2c3d4:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t234cd5e:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t234cd5e:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t2c3d4e5:disabled`: candidates 2/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t2c3d4e5:enabled`: candidates 2/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t345de6f:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t345de6f:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t3d4e5f6:disabled`: candidates 2/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t3d4e5f6:enabled`: candidates 2/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t456ef70:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t456ef70:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t4e5f607:disabled`: candidates 2/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t4e5f607:enabled`: candidates 2/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t567f081:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t567f081:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t5f60718:disabled`: candidates 2/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t5f60718:enabled`: candidates 2/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t6071829:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t6071829:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t6780192:disabled`: candidates 2/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t6780192:enabled`: candidates 2/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t718293a:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t718293a:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t7891a03:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t7891a03:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t8293a4b:disabled`: candidates 2/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t8293a4b:enabled`: candidates 2/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t93a4b5c:disabled`: candidates 2/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:t93a4b5c:enabled`: candidates 2/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:ta4b5c6d:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:ta4b5c6d:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:tb5c6d7e:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:tb5c6d7e:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:tc6d7e8f:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:tc6d7e8f:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:td7e8f90:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:td7e8f90:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:te8f901a:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:te8f901a:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:tf901a2b:disabled`: candidates 1/5, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `regression:tf901a2b:enabled`: candidates 1/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `filter:c015-vs-c115`: candidates 2/15, limit 5, bound 15, calls docs/chunks/collections/list 1/1/1/0
- Structural `zero:absent`: candidates 2/2, limit 2, bound 6, calls docs/chunks/collections/list 1/1/1/0
- Structural `zero:disabled`: candidates 2/2, limit 2, bound 6, calls docs/chunks/collections/list 1/1/1/0
- Structural `zero:unavailable`: candidates 2/2, limit 2, bound 6, calls docs/chunks/collections/list 1/1/1/0
- Structural `zero:untrusted_remote`: candidates 2/2, limit 2, bound 6, calls docs/chunks/collections/list 1/1/1/0

## Limitations

- Controlled vector distances isolate the bounded promotion seam; they do not claim general retrieval superiority.
- The fixture agent still selects hard collections and MCP project hints remain untrusted zero-affinity inputs.
- Results apply only to this closed synthetic corpus and exact committed identities.
