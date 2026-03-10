# Fine-Tuning Pattern

Reusable pattern for retrieval-model fine-tuning projects.

## Core Principle

Do not optimize training loss alone.

Optimize this loop:

1. prepare task-specific data
2. train a candidate
3. pick the best checkpoint
4. export the artifact used by the real runtime
5. benchmark the exported artifact
6. keep/discard based on the real benchmark

## Required Pieces

- strict training schema
- heldout benchmark split
- portable export path
- automated checkpoint selection
- promotion bundle
- keep/discard experiment history

## Mutation Order

1. data mix
2. prompt / reward knobs
3. training config
4. alternate model base

## Corpus Strategy

- start from the strongest existing task-adjacent corpus you have
- adapt it to the local schema/contract
- add project-specific hardcases on top
- avoid over-pruning the imported corpus unless you can prove it is hurting the real benchmark
- keep ask-style prompts low-weight unless standalone answer synthesis is a core product objective

## Why This Order

- data quality usually beats blind hyperparameter churn
- prompt/reward changes are cheap and legible
- training configs are next-best once the signal is clean
- alternate bases should come last, after the pipeline is trustworthy

## Portability Rule

- training backend can be local/machine-specific
- promoted artifact must be runtime-portable

In `gno` that means:

- MLX training is acceptable
- GGUF export is the deployable artifact
