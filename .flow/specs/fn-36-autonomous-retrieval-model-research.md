# Autonomous Retrieval Model Research Harness

## Goal

Build an agent-driven experiment loop that can improve retrieval-model training code inside a sandbox using a fixed metric, short runtime budget, and explicit safety rules.

## Start Here

A new agent should be able to execute this epic cold in this order:

1. confirm the benchmark epic selected a base model worth optimizing
2. confirm the fine-tuning sandbox exists and has a trusted metric
3. constrain mutation scope
4. define the experiment loop, logging, and promotion gate
5. run a dry-run or noop experiment proving the harness is safe

## Why This Comes Third

Autonomy is only useful once:

- we know which base model we care about
- we have a stable training sandbox
- we trust the reward / eval function

Without those, the agent will optimize noise.

## External References

Useful references for the next agent:

- Andrej Karpathy `autoresearch`: <https://github.com/karpathy/autoresearch>
- local upstream reference training stack already cloned under `~/repos`
- the sandbox defined by `fn-35`

These references are for harness design only. The autonomous loop must optimize `gno`’s own sandbox metric and must not mutate product code.

## Mutation Surface

The harness must not mutate product code.

Allowed mutation targets:

- sandbox training scripts
- sandbox config files
- sandbox prompt / policy files
- experiment scheduler / harness code

Disallowed:

- CLI / API / MCP / Web product code
- core runtime code outside the sandbox
- eval fixtures that define the held-out benchmark

## Loop Design

The harness should follow a constrained experiment cycle:

1. read the current policy / prompt
2. mutate a small number of sandbox files
3. run one short experiment
4. score against a fixed metric
5. keep or discard changes
6. log result + rationale
7. repeat

## Required Guardrails

- fixed experiment time budget per run
- fixed held-out metric
- branch-local commits only
- explicit rollback / rejection of worse runs
- no silent mutation of benchmark sets
- human promotion gate before anything reaches product/runtime defaults

## Logging / Artifacts

Every run should emit:

- experiment id
- commit sha
- changed files
- config diff or prompt diff
- metric result
- runtime cost
- keep / discard decision

The history should be easy to compare across prompts, agents, and search strategies.

## Human Role

The human should iterate on:

- the policy / instructions
- mutation boundaries
- metric definition
- promotion rules

The agent should iterate on:

- training code inside the sandbox
- hyperparameters
- prompt variants for the training pipeline

## Deliverables

- harness design doc
- prompt / policy template
- logging format
- run directory structure
- promotion rules
- first dry-run or noop-run proving the loop boundary is safe

## Handoff Notes

- Do not start with unconstrained repo-wide code mutation.
- Keep the mutation target intentionally tiny.
- Assume the agent will exploit any weakness in the metric, so lock the metric before scaling the loop.

## Acceptance

- Mutation scope is constrained to sandbox files only
- Experiment budget and metric are fixed and documented
- Logging format is defined
- Human promotion gate is explicit
- Harness can be run without touching production retrieval code
