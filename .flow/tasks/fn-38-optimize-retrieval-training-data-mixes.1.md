# fn-38-optimize-retrieval-training-data-mixes.1 Run multilingual-boost dataset experiment

## Description

TBD

## Acceptance

Run the first targeted data-mix experiment using the new mix-variant tooling. Start with the multilingual-boost mix because multilingual retrieval is a known weakness and a likely source of lift.

Acceptance:

- build a variant dataset from the multilingual-boost mix
- launch a real training run against that variant dataset
- record the run config and rationale in the sandbox run history
- verify the run starts cleanly and reaches at least the first validation checkpoint

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
