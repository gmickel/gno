# Code Embedding Research

Harnesses for evaluating alternate embedding models on code retrieval.

This research lane is intentionally separate from `research/finetune/`:

- no model fine-tuning
- no prompt/profile mutation
- candidate search over alternate embedding model URIs

Core pieces:

- `scripts/code-embedding-benchmark.ts`
- `evals/helpers/code-embedding-benchmark.ts`
- `evals/fixtures/code-embedding-benchmark/`
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

Do not change product defaults from this harness directly.
Promotion remains a human decision.

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
- some challengers are most realistic to evaluate via an HTTP embedding server first, then map to a final runtime URI once we decide they are worth deeper testing

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
      embed: "http://your-embedding-server/v1/embeddings#your-code-model"
```

That recommendation belongs in `docs/CONFIGURATION.md`, relevant benchmark docs, and any future benchmark/results page.
