# Retrieval Fine-Tuning Sandbox

Isolated training/eval sandbox for retrieval-specific models.

Current scope:

- expansion only
- recommended base from fn-34: `Qwen3-1.7B-Q4_K_M`
- product runtime stays untouched; this directory defines data/contracts/export path only

## Goals

- make expansion-model experimentation reproducible
- keep training code/data/contracts separate from CLI/Web/MCP product code
- define promotion gates before any fine-tuned model is considered for runtime use

## First Supported Path

- task: structured query expansion
- training stage: SFT first
- optional later stage: RL/reward optimization
- base model: `Qwen/Qwen3-1.7B`
- runtime artifact target: GGUF `Q4_K_M`

## Directory Layout

```text
research/finetune/
├── configs/
│   └── expansion-qwen3-1.7b-sft.json
├── contracts/
│   ├── eval-contract.md
│   ├── export-contract.md
│   └── reward-contract.md
├── data/
│   ├── promotion/
│   │   └── promotion-cases.jsonl
│   ├── splits/
│   │   ├── heldout.json
│   │   ├── train.json
│   │   └── validation.json
│   └── training/
│       └── README.md
├── runs/
│   └── 2026-03-09-fn-34-baseline.md
├── schemas/
│   ├── expansion-sandbox-config.schema.json
│   ├── expansion-training-example.schema.json
│   └── promotion-case.schema.json
└── scripts/
    ├── bootstrap-promotion-fixtures.ts
    └── validate-sandbox.ts
```

## Quick Start

Import qmd examples into the sandbox schema:

```bash
bun run research:finetune:qmd-import
```

Build an MLX LoRA training dataset:

```bash
bun run research:finetune:mlx:build-dataset
bun run research:finetune:build-variant-dataset research/finetune/configs/mixes/multilingual-boost.json
bun run research:finetune:list-prompt-variants
```

Run a local MLX LoRA training job:

```bash
bun run research:finetune:mlx:train
```

Fuse adapters and export a portable GGUF:

```bash
bun run research:finetune:promote mlx-run1

# equivalent expanded form:
bun run research:finetune:select-best mlx-run1
bun run research:finetune:fuse-best mlx-run1
bun run research:finetune:export-env
bun run research:finetune:export-gguf mlx-run1
bun run research:finetune:smoke-gno-export mlx-run1
bun run research:finetune:benchmark-export mlx-run1
bun run research:finetune:promotion-bundle mlx-run1
```

Smoke the adapter against the JSON contract:

```bash
bun run research:finetune:mlx:smoke
```

Bootstrap promotion fixtures from current evals:

```bash
bun run research:finetune:bootstrap
```

Validate schemas + split contracts:

```bash
bun run research:finetune:validate
```

Re-run the current product baseline before changing anything:

```bash
bun run eval:retrieval-candidates:write
```

Plan an alternate-base sweep:

```bash
bun run research:finetune:plan-sweep
```

List data-mix variants for autonomous exploration:

```bash
bun run research:finetune:list-mix-variants
```

## Data Surfaces

### 1. Training examples

Future SFT/RL training examples must validate against:

- `schemas/expansion-training-example.schema.json`

Required properties:

- `query`
- `target.lexicalQueries`
- `target.vectorQueries`
- optional `target.hyde`
- retrieval metadata needed to score preservation/drift

Training examples are expected under `data/training/`.

Current seeded sources:

- `data/training/gno-hardcases.jsonl`
- `data/training/gno-multilingual-hardcases.jsonl`
- `data/training/gno-disambiguation-hardcases.jsonl`
- `data/training/gno-lexical-preservation-hardcases.jsonl`
- `data/training/gno-ask-hardcases.jsonl`
- generated qmd import via `bun run research:finetune:qmd-import`

Current training mix:

- `configs/training-mix.json`
- imported qmd data remains the majority corpus
- `gno`-specific retrieval data is boosted on top of that, not used as a replacement
- multilingual, ambiguous, negation, and exact-lexical cases are favored over ask-style prompting
- variant mixes for autonomous search:
  - `configs/mixes/balanced-retrieval-v2.json`
  - `configs/mixes/qmd-majority.json`
  - `configs/mixes/multilingual-boost.json`
  - `configs/mixes/lexical-boost.json`

Prompt profiles:

- default: `configs/prompt-profile.json`
- variants:
  - `configs/prompt-profiles/strict-json-v2.json`
  - `configs/prompt-profiles/entity-lock-v1.json`

Ask-style prompts remain in the corpus only as retrieval probes. They are not the main optimization target.

### 2. Promotion cases

Promotion cases are benchmark-only.

- derived from existing `gno` eval fixtures
- stored in `data/promotion/promotion-cases.jsonl`
- split into `train`, `validation`, and `heldout`
- `heldout` is promotion-only; do not tune prompts/hparams against it

Current split policy:

- `train`: mostly baseline retrieval cases
- `validation`: remaining baseline plus non-heldout adversarial cases
- `heldout`: all ask-style cases, all multilingual cases, and the highest-risk adversarial entity/negation cases

## Promotion Rule

Do not promote a sandbox model unless it beats the current shipped base on:

- heldout retrieval quality
- structured-output compliance
- entity/negation preservation

And does so without unacceptable regressions in:

- p95 latency
- memory footprint
- local usability

See:

- `contracts/eval-contract.md`
- `contracts/reward-contract.md`
- `contracts/export-contract.md`
- `runs/2026-03-09-fn-34-baseline.md`

## When To Rerun The Current Winner

Prefer another run on the current `Qwen3-1.7B` winner when:

- the latest promoted run is still improving heldout retrieval or structure
- latency is already acceptable
- you changed data, reward, or prompts more than model-family assumptions

Prefer an alternate-base sweep when:

- the winner plateaus across multiple runs
- you need a lighter fast-path model
- you need better structure that prompt/reward changes are not delivering
- a new base changes the quality/cost frontier enough to justify retesting

Current sweep manifest:

- `configs/alternate-base-sweep.json`

## Run History

- `runs/2026-03-09-mlx-calibration.md`
- `runs/2026-03-09-mlx-run2.md`
- `runs/2026-03-09-mlx-run6.md`

Practical lesson so far:

- lower training/validation loss does not guarantee better retrieval
- promotion decisions must follow exported-model benchmark results
- retrieval-centric data quality beats blind hyperparameter scaling
- augmenting a strong imported corpus is better than pruning it too aggressively
- multilingual data matters, but a multilingual-heavy mix can still overcorrect and hurt overall quality

## External Reference Mapping

Reference stack:

- `/Users/gordon/repos/qmd/finetune`

Borrowed ideas:

- strict data schema
- explicit reward contract
- GGUF export stage
- autonomous loop kept inside sandbox

Deliberate differences for `gno`:

- output contract matches `gno` JSON expansion shape, not `lex:/vec:/hyde:` lines
- promotion set is tied to `gno` eval fixtures and ask-style retrieval
- export target is local `gno` runtime URI compatibility

## MLX Local Backend

Local backend:

- training base: `mlx-community/Qwen3-1.7B-4bit`
- trainer: `python3 -m mlx_lm lora`
- fuse/export: `python3 -m mlx_lm fuse --export-gguf`

Portable outputs:

- adapter weights
- fused MLX model
- GGUF export for `llama.cpp` / `node-llama-cpp`

Current observed limitation:

- `mlx_lm fuse --export-gguf` fails for `qwen3` with current MLX tooling
- working path:
  - `mlx_lm fuse --dequantize`
  - `llama.cpp convert_hf_to_gguf.py`
  - smoke the GGUF through `gno`

## Troubleshooting

### MLX training works but background jobs exit immediately

Use an attached PTY or terminal session for long-running MLX jobs if your shell
environment drops detached jobs unexpectedly.

### GGUF export fails on the fused quantized model

Export the dequantized fused model instead:

1. `bun run research:finetune:fuse-best <run>`
2. `bun run research:finetune:export-env`
3. `bun run research:finetune:export-gguf <run>`

### The best checkpoint is not the final checkpoint

Use:

```bash
bun run research:finetune:select-best <run>
```

The promotion path uses validation loss to pick the best saved checkpoint rather
than assuming the final adapter is best.

### Exported model loads but still has weak structure

Use:

```bash
bun run research:finetune:smoke-gno-export <run>
```

This shows raw output plus parsed expansion output so you can distinguish:

- export/runtime breakage
- prompt drift
- insufficient training

## Autonomous Layer

fn-36 builds on this sandbox under `research/finetune/autonomous/`.

- config: `autonomous/config.json`
- policy: `autonomous/policy.md`
- dry-run proof: `bun run research:finetune:autonomous:noop`
- unattended search preview: `bun run research:finetune:autonomous:search --dry-run`
- unattended search run: `bun run research:finetune:autonomous:search`
- search loop early-stops weak candidates at validation checkpoints, then promotes only surviving checkpoints
