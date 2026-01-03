# GNO Evals

Evaluation harness for search ranking and answer generation quality using [Evalite](https://evalite.dev).

## Quick Start

```bash
# Run all evals and update scores.md
bun run evals

# Include LLM evals (slower, requires model download)
bun run evals --include-llm

# Run single eval
bun run eval evals/vsearch.eval.ts
```

## Current Scores

See [scores.md](scores.md) for latest results. Updated automatically by `bun run evals`.

## Eval Overview

| Eval             | What it tests                          | Status                       |
| ---------------- | -------------------------------------- | ---------------------------- |
| **vsearch**      | BM25 search ranking (Recall@K, nDCG@K) | ✅ Passing                   |
| **query**        | Query parsing and latency              | ✅ Passing                   |
| **expansion**    | Query expansion validity               | ✅ Passing                   |
| **thoroughness** | Fast/balanced/thorough comparison      | ✅ Passing                   |
| **multilingual** | Cross-language retrieval               | ⚠️ Placeholder (see below)   |
| **ask**          | Answer generation quality              | ⚠️ LLM-dependent (see below) |

## Known Limitations

### Multilingual (38% score)

Cross-language retrieval is a placeholder. Current BM25 search doesn't translate queries or use multilingual embeddings. Future work:

- Query translation or multilingual embeddings
- Per-language FTS indexes
- Language-specific stemmers

For now, this eval documents the gap rather than gating releases.

### Ask Eval (61% score)

Tests answer generation with local LLM models across all three presets. Current scores:

| Preset   | Model               | Score |
| -------- | ------------------- | ----- |
| slim     | Qwen3-1.7B          | 69%   |
| balanced | Qwen2.5-3B-Instruct | ~50%  |
| quality  | Qwen3-4B-Instruct   | 77%   |

Key findings:

- **3B models inconsistent with citations** - can produce good answers but citation formatting unreliable
- **Qwen3 models handle citations better** - both slim (1.7B) and quality (4B) more reliable
- **No LLM judge without API key** - Requires `OPENAI_API_KEY` for full "Good Answer" scoring

The balanced preset trades some citation reliability for faster inference and lower memory.

### Not Yet Implemented

- **Vector search evals** - Requires embedding infrastructure
- **Latency budgets** - Measure first, then set thresholds

## Architecture

```
evals/
├── fixtures/
│   ├── corpus/{de,en,fr,it}/  # Multilingual test documents
│   ├── queries.json           # Search queries with relevance judgments
│   └── ask-cases.json         # Answer generation test cases
├── helpers/
│   └── setup-db.ts            # Temp DB creation for evals
├── scorers/
│   └── ir-metrics.ts          # Recall@K, nDCG@K scorers
├── *.eval.ts                  # Eval definitions
├── scores.md                  # Auto-generated results
├── CLAUDE.md                  # Quick reference for AI assistants
└── README.md                  # This file
```

## Adding New Evals

1. Create `evals/new-feature.eval.ts`
2. Use `evalite()` from "evalite" package
3. Get shared DB: `await getSharedEvalDb()`
4. Add scorers with 0-1 normalized scores
5. Run `bun run eval:scores` to verify
6. Update this README with status

## CI/CD

Evals are **local only** - not run in CI. They're part of the manual release DoD:

1. `bun run lint:check` - must pass
2. `bun test` - must pass
3. `bun run eval:scores` - must pass 70% threshold

This is intentional: evals require model downloads and can be slow. They validate quality before release, not on every commit.

## Configuration

See `evalite.config.ts`:

- `testTimeout`: 120s (for model downloads)
- `maxConcurrency`: 5
- `scoreThreshold`: 70%
- `cache`: true (faster iteration)
