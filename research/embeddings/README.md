# Embedding Research

Harnesses for evaluating alternate embedding models on both code retrieval and
general multilingual markdown collections.

This research lane is intentionally separate from `research/finetune/`:

- no model fine-tuning
- no prompt/profile mutation
- candidate search over alternate embedding model URIs

Core pieces:

- `scripts/code-embedding-benchmark.ts`
- `scripts/general-embedding-benchmark.ts`
- `evals/helpers/code-embedding-benchmark.ts`
- `evals/helpers/general-embedding-benchmark.ts`
- `evals/fixtures/code-embedding-benchmark/`
- `evals/fixtures/general-embedding-benchmark/`
- `research/embeddings/autonomous/`

Suggested workflow:

```bash
# 1. Establish or refresh the incumbent baseline
bun run bench:code-embeddings --candidate bge-m3-incumbent --write

# Optional: benchmark against a real repo slice instead of the fixed corpus
bun run bench:code-embeddings --candidate bge-m3-incumbent --fixture repo-serve --write

# 2. Add candidate model URIs to the autonomous search space
$EDITOR research/embeddings/autonomous/search-space.json

# 3. Inspect and run candidates manually
bun run research:embeddings:autonomous:list-search-candidates
bun run research:embeddings:autonomous:run-candidate <candidate-id>

# 4. Let the bounded search loop process the remaining candidates
bun run research:embeddings:autonomous:search --dry-run
```

For the general multilingual markdown lane:

```bash
# Establish general-docs baseline
bun run bench:general-embeddings --candidate bge-m3-incumbent --write

# Compare the strongest challenger so far
bun run bench:general-embeddings --candidate qwen3-embedding-0.6b --write
```

Do not change product defaults from this harness directly.
Promotion remains a human decision.

## Benchmark lanes

### Code

- `evals/fixtures/code-embedding-benchmark/`
- compares code-specialist behavior on canonical, repo, and OSS code slices

### General multilingual markdown

- `evals/fixtures/general-embedding-benchmark/`
- compares prose/docs retrieval on public multilingual markdown only
- currently sourced from vendored FastAPI docs snapshots

## First model shortlist

Baseline:

- `bge-m3` (current incumbent)

First challenger batch:

- `Qwen3-Embedding-0.6B`
- `jina-code-embeddings-0.5b`
- `F2LLM-0.6B`

Notes:

- the canonical benchmark corpus is intentionally small and language-diverse
- the `repo-serve` fixture lets us compare models on actual GNO code under `src/serve`
- the `oss-slices` fixture lets us compare models on pinned public OSS repo slices without vendoring third-party code into GNO
- some challengers are most realistic to evaluate via an HTTP embedding server first, then map to a final runtime URI once we decide they are worth deeper testing

## Current winner for code

Current best result:

- `Qwen3-Embedding-0.6B-GGUF`

Why:

- ties `bge-m3` on the canonical benchmark
- substantially outperforms `bge-m3` on the real GNO `repo-serve` slice
- also cleanly outperforms `bge-m3` on the pinned `oss-slices` public-OSS fixture
- uses the same native GGUF embedding runtime GNO already ships

Current non-recommendation:

- `jina-code-embeddings-0.5b-GGUF` is not currently recommended in GNO's native runtime despite promising canonical scores, because it produced embedding-id/runtime issues and collapsed on the real-code slice

## If a code-specific winner emerges

Do two things:

1. document the benchmark result in:
   - `evals/fixtures/code-embedding-benchmark/canonical.md`
   - `evals/fixtures/code-embedding-benchmark/repo-serve.md`
2. document a user-facing config recommendation:
   - keep the current global preset if it still works well for prose/mixed collections
   - use per-collection `models.embed` overrides for code collections

Example pattern:

```yaml
collections:
  - name: gno-code
    path: /Users/you/work/gno/src
    pattern: "**/*.{ts,tsx,js,jsx,go,rs,py,swift,c}"
    models:
      embed: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

That recommendation belongs in `docs/CONFIGURATION.md`, relevant benchmark docs, and any future benchmark/results page.

Latency note:

- `Qwen3-Embedding-0.6B-GGUF` is currently slower than `bge-m3`
- the recommendation is therefore:
  - keep `bge-m3` globally for mixed/prose collections
- use Qwen specifically where code retrieval quality matters more than embedding speed

## Current general multilingual winner

Current best general-docs result:

- `Qwen3-Embedding-0.6B-GGUF`

Public multilingual markdown benchmark numbers:

- `bge-m3`: vector nDCG@10 `0.350`, hybrid nDCG@10 `0.642`
- `Qwen3-Embedding-0.6B-GGUF`: vector nDCG@10 `0.859`, hybrid nDCG@10 `0.947`

Interpretation:

- Qwen materially outperforms the incumbent on the new multilingual prose/docs
  lane too
- this was strong enough to justify switching the built-in preset default embed
  model from `bge-m3` to `Qwen3-Embedding-0.6B-GGUF`
- existing users still need a fresh `gno embed` pass after upgrading if they
  want vector and hybrid retrieval to catch up to the new default
