# fn-36-autonomous-retrieval-model-research.1 Prototype an autonomous experiment loop for retrieval models

## Description

Define the first safe autonomous loop for retrieval-model experimentation. This is a harness task, not a product-model task: the goal is to constrain mutation scope, fix the metric, fix the runtime budget, and make the experiment history legible.

## Acceptance

- Define the allowed mutation surface.
- Define the fixed experiment budget and held-out metric.
- Define logging/artifact output for each run.
- Define human promotion / rollback rules.
- Prove the loop can run without touching production retrieval code.

## Notes For Implementer

- Keep the loop inside the training sandbox only.
- Assume agents will optimize the metric you give them, so make the metric trustworthy first.
- Prefer one-file / very small-file mutation targets.
- External references:
  - Andrej Karpathy `autoresearch`: <https://github.com/karpathy/autoresearch>
  - local reference training stack: `/Users/gordon/repos/qmd/finetune`

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
