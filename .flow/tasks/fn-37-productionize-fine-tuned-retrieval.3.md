# fn-37-productionize-fine-tuned-retrieval.3 Add alternate-base sweep path

## Description

Add a clear sweep path for alternate Qwen bases after the current `Qwen3-1.7B` winner, including decision rules for when to stay on the winner versus branching out.

## Acceptance

Add a candidate sweep path for other promising bases after the current 1.7B winner.

Acceptance:

- sweep config format exists for alternate bases
- at least Qwen2.5-3B and one Qwen3.5 candidate are represented
- docs define when to run a new-base sweep versus another run on the current winner
- benchmark results for alternate runs are comparable to the promoted path

## Done summary

Added an alternate-base sweep path for future Qwen candidate exploration. The sandbox now includes a sweep manifest, a planning command, and explicit decision rules for when to keep rerunning the current Qwen3-1.7B winner versus trying Qwen2.5-3B or Qwen3.5 candidates.

## Evidence

- Commits:
- Tests: bun run research:finetune:plan-sweep, bun test test/research/alternate-sweep.test.ts, bun run lint:check
- PRs:
