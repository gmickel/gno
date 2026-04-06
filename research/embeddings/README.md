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
