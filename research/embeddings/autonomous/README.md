# Autonomous Code Embedding Search Harness

Bounded search loop for alternate embedding models on code retrieval.

Scope:

- keep product code fixed
- vary candidate embedding model URIs
- benchmark candidates on the fixed code corpus
- keep or discard based on weighted benchmark deltas

Main files:

```text
research/embeddings/autonomous/
├── config.json
├── policy.md
├── search-space.json
├── runs/
├── lib/
│   └── results.ts
└── scripts/
    ├── leaderboard.ts
    ├── list-search-candidates.ts
    ├── run-candidate.ts
    └── search.ts
```

This harness is inspired by the same bounded-research approach used in `research/finetune/autonomous/`, but the mutable surface is smaller:

- candidate list
- scoring policy
- benchmark harness

No training runs occur here.
