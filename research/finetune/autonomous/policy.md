# Autonomous Policy v1

The agent is optimizing the sandbox, not the product.

## Goal

Improve expansion-model training/eval behavior inside `research/finetune/` while preserving:

- heldout metric integrity
- sandbox reproducibility
- local runtime practicality

## Mutation Rules

- mutate at most 4 files per run
- mutate only allowed roots from `config.json`
- never mutate heldout benchmark content
- never mutate product code
- never auto-promote a candidate to runtime defaults

## Decision Rules

Keep a run only if:

- validation command passes
- heldout metric improves or structure defects decrease without metric regression
- runtime budget stays within config

Discard immediately if:

- heldout metric regresses
- mutation escapes allowed roots
- run budget is exceeded
- metric source changes during the run

## Human Gate

Only a human may:

- change the heldout split
- widen mutation roots
- switch the base model
- adopt a fine-tuned artifact into `gno` presets/defaults
