# fn-37-productionize-fine-tuned-retrieval.4 Operationalize autonomous optimization loop

## Description

Operationalize the autonomous harness so it can evaluate real fine-tune runs against the promotion metric while staying inside the sandbox.

## Acceptance

Turn the autonomous harness into a real optimizer over the productionized sandbox metric.

Acceptance:

- autonomous loop can target specific sandbox config/prompt/reward files
- run logs include keep/discard decision and metric deltas
- loop can call the promotion pipeline without touching product code
- human promotion gate remains explicit

## Done summary
Extended the autonomous harness into a real sandbox evaluation cycle. The harness now validates mutation targets, runs the full promotion pipeline on a named run, computes benchmark deltas vs the shipped baseline, and emits a keep/discard decision artifact without touching product code or runtime defaults.
## Evidence
- Commits:
- Tests: bun run research:finetune:autonomous:evaluate mlx-run1, bun test test/research/autonomous-policy-cycle.test.ts test/research/autonomous-harness.test.ts, bun run lint:check
- PRs: