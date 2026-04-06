# General Embedding Benchmark Fixtures

Public multilingual markdown fixture for evaluating embedding models on normal
collections, not code-only trees.

Why this exists:

- product-default embedding decisions should not rely on private corpora
- code retrieval wins do not automatically transfer to prose/docs collections
- multilingual retrieval matters for GNO's default model choice

Current corpus:

- FastAPI documentation pages vendored from the public `fastapi/fastapi` repo
- same topics across multiple languages:
  - `index`
  - `features`
  - `async`
- languages:
  - English
  - German
  - French
  - Spanish
  - Chinese (Simplified)

Files:

- `sources.json` - provenance and license metadata for every vendored file
- `queries.json` - benchmark cases and graded relevance judgments
- `corpus/` - vendored markdown snapshots

Primary use:

```bash
bun scripts/general-embedding-benchmark.ts --candidate bge-m3-incumbent --write
bun scripts/general-embedding-benchmark.ts --candidate qwen3-embedding-0.6b --write
```

This lane is intentionally separate from:

- `evals/fixtures/code-embedding-benchmark/`

because the question here is different:

- should an embedding model become better for normal multilingual collections
- not just whether it wins on source-code retrieval
