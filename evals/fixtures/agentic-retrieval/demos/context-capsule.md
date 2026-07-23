# Context Capsule: one frozen agent outcome

Canonical fingerprint: `a2001a5b7052ad5d325a2b4336d9598192651c588992bc732729e10a739647d4`

This is one controlled exact-identifier task, not a general superiority claim.

## Frozen task

> Find the incident identifier assigned to the failed north gateway deployment.

Expected answer: `INC-4827`

Exact evidence: `gno://c001/d001.md:3-3`  
Source SHA-256: `f02c60996c5114f6ceb2f7cbfc96094f7a8df034ffd1bb62dfb841fba37099aa`  
Span SHA-256: `db94cbe64c5c6c10d582eff7ff7d18fd2410bcbe8bbb1af42281bbfb7d69f320`

## Measured outcome

| Lane                   | Stop outcome       | Success | Evidence coverage | Agent calls | Context bytes |      Tokens | Cold end-to-end ms |
| ---------------------- | ------------------ | ------: | ----------------: | ----------: | ------------: | ----------: | -----------------: |
| Lexical-only baseline  | complete: INC-1042 |       0 |                 0 |           2 |          2744 | unavailable |              1.283 |
| Current GNO primitives | complete: INC-1042 |       0 |                 0 |           2 |          2222 | unavailable |           1375.758 |
| Context Capsule        | complete: INC-4827 |       1 |                 1 |           1 |          1295 | unavailable |              2.191 |

Tokens are unavailable because this run did not use one pinned comparable tokenizer.
Latency is the single matching cold-lifecycle observation on the recorded environment.

## Methodology

- One frozen fixture task, outer agent, trial, seed, lifecycle, corpus, prompt, tool contract, model, runtime, and effective index are compared across all three lanes.
- The lexical lane is the no-GNO retrieval baseline; current GNO uses shipped MCP query/get primitives; the Capsule lane uses the production model-visible Context Capsule projection.
- Exact hidden-oracle values and source spans score the final structured envelope without an LLM judge.
- UTF-8 bytes include each complete normalized model-visible tool-result envelope. Tokens remain unavailable because the run did not use one pinned comparable tokenizer.
- End-to-end latency is reported only for the matching cold lifecycle on the recorded environment; preparation is outside the scored interval.

Variance: This deterministic demonstration has one frozen trial; it is not a statistical latency or quality estimate.

## Capsule retrieval contract

- Request: `{"arguments":{"collection":"c001","query":"incident identifier"},"toolName":"search"}`
- Effective index: `9c4a65f08850a70ff6d2ec6fe069b4cd38c9cbf3481583afd76a74264cf0591a`
- Fallbacks: `[]`
- Capability states and the complete normalized payload are retained in the JSON artifact.

## Separate Verified Ask answer-enforcement proof

This is not a retrieval lane and its answer metrics are not retrieval metrics.

- Frozen paired cohort: 22
- Excluded missing-evidence tasks: t234cd5e, t345de6f
- Answer accuracy, raw/verified: 0.8181818181818182 / 0.8181818181818182
- Unsupported substantive claims, raw/verified: 4 / 0
- Unsupported-claim reduction: 1

## Limitations

- Controlled fixtures are regression evidence, not a representative workload claim.
- Fixture-agent behavior is deterministic and narrower than a general model.
- UTF-8 bytes are the primary context measure; tokens are null without one pinned tokenizer.
- Latency is environment-specific and comparable only within a matching lifecycle.
- qmd is optional, exact-revision pinned, and non-authoritative for Capsule promotion.
- Capsule retrieval is a fixture prototype; its model-visible serializer and omission accounting are the production MCP contract.
- This page reports one controlled exact-identifier task. It does not extrapolate general product superiority.
