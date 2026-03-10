# Build Retrieval Fine-Tuning Sandbox

## Goal

Create an isolated, reproducible training sandbox for `gno` retrieval models, starting with query expansion.

## Start Here

A new agent should be able to execute this epic cold in this order:

1. read the benchmark recommendation from `fn-34`
2. define the sandbox directory structure
3. define the training/eval schema and held-out split
4. define the reward function and promotion contract
5. define the export path back into local `gno` runtime testing

## Why This Is Separate From Product Code

Training loops, datasets, reward scripts, and export tooling should evolve quickly without destabilizing the CLI / Web / MCP product code. The sandbox should be intentionally isolated so future agents can iterate there safely.

## Initial Focus

Start with **query expansion**, not reranking.

Reason:

- expansion has a clean structured-output contract
- we already have eval fixtures and known failure modes
- it is cheaper to train and benchmark
- it is the best fit for later autonomous experimentation

Reranker training should only become first-class after we have stronger labeled relevance data and a clear base-model decision from the benchmark epic.

## External References

Useful references for the next agent:

- Andrej Karpathy `autoresearch`: <https://github.com/karpathy/autoresearch>
- local upstream reference training stack already cloned under `~/repos`
- current `gno` evals and fixtures in-repo

These references should inform the sandbox design, but the sandbox must be tailored to `gno` contracts and evals.

## Proposed Sandbox Shape

The spec should be implemented under a dedicated tracked directory such as:

- `research/finetune/`

Expected components:

- training entrypoint
- reward / scoring function
- eval runner
- dataset schema and validators
- export / GGUF conversion path
- experiment configs
- README for reproducibility

## Data Requirements

Training and eval data should be `gno`-specific.

Minimum sources:

- existing eval fixtures
- handcrafted hard cases
- ambiguous queries
- entity-heavy technical queries
- negation / exclusion-sensitive queries
- multilingual queries
- Ask-style retrieval prompts

Data split requirements:

- train
- validation
- held-out test set used only for promotion decisions

## Output Contract

The expansion model must target a rigid structured format aligned to `gno` retrieval stages.

The contract should explicitly preserve:

- lexical constraints
- semantic reformulations
- optional hypothetical passage
- entities
- negations / exclusions
- predictable machine-readable formatting

## Reward / Eval Requirements

The reward and eval stack should score things that matter to `gno`, not generic chat quality.

Required dimensions:

- format correctness
- structured-output compliance
- entity preservation
- negation / exclusion preservation
- lexical / semantic diversity without drift
- retrieval lift on held-out queries
- latency budget

## Runtime / Export Requirements

The sandbox must include a documented path from trained output to local `gno` runtime use.

Required:

- GGUF export or equivalent local runtime artifact
- documented model URI format for local testing
- reproducible commands for evaluation in `gno`

## Deliverables

- sandbox directory skeleton
- README with exact commands
- dataset schema
- eval contract
- reward contract
- export path
- first baseline run documented

## Handoff Notes

- Keep this epic scoped to sandbox design and the first supported path.
- Start with expansion only.
- Do not couple the sandbox to production product code.
- Make every artifact reproducible by another agent with commands written into the sandbox README.

## Acceptance

- Sandbox layout defined and documented
- Expansion-model training is the first supported path
- Product code and sandbox code are clearly separated
- Held-out eval split exists for promotion decisions
- Export path to local runtime is documented and reproducible
