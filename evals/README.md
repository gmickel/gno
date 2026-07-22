# GNO Evals

Evaluation harness for search ranking and answer generation quality using [Evalite](https://evalite.dev).

## Quick Start

```bash
# Run public fixture benchmark against an indexed GNO corpus
gno bench docs/examples/bench-fixture.json

# Run all evals and update scores.md
bun run evals

# Run hybrid benchmark only
bun run eval:hybrid

# Generate hybrid baseline snapshot artifacts
bun run eval:hybrid:baseline

# Compare current benchmark to latest baseline
bun run eval:hybrid:delta

# Benchmark local candidate generation bases for retrieval
bun run eval:retrieval-candidates

# Write raw candidate benchmark artifacts + summary
bun run eval:retrieval-candidates:write

# Include LLM evals (slower, requires model download)
bun run evals --include-llm

# Run single eval
bun run eval evals/vsearch.eval.ts
```

## Current Scores

See [scores.md](scores.md) for latest results. Updated automatically by `bun run evals`.

## Eval Overview

`gno bench <fixture.json>` is the public, local fixture runner for your own corpora. The Evalite suites below remain internal release/development gates.

| Eval                     | What it tests                                    | Status                       |
| ------------------------ | ------------------------------------------------ | ---------------------------- |
| **vsearch**              | Legacy BM25 ranking suite (Recall@K, nDCG@K)     | ✅ Passing                   |
| **query**                | Query parsing and latency                        | ✅ Passing                   |
| **hybrid**               | End-to-end hybrid benchmark + p50/p95            | ✅ Passing                   |
| **retrieval-candidates** | Candidate gen-model benchmark (full hybrid path) | ✅ Available for manual runs |
| **expansion**            | Query expansion validity                         | ✅ Passing                   |
| **thoroughness**         | Fast/balanced/thorough comparison                | ✅ Passing                   |
| **multilingual**         | Cross-language retrieval                         | ⚠️ Placeholder (see below)   |
| **ask**                  | Answer generation quality                        | ⚠️ LLM-dependent (see below) |

## Hybrid Blend Policy Notes

- Rerank blending is tiered by rank: top results keep stronger fusion weight.
- Original BM25 rank-1 hit is protected from rerank-only demotion.
- `bun run eval:hybrid` should be used to validate quality after blend tuning.
- `bun run eval:hybrid:baseline` snapshots current metrics for later delta checks.
- `bun run eval:hybrid:delta` prints quality/latency deltas against `hybrid-baseline/latest.json`.

## Retrieval Candidate Benchmark

- `bun run eval:retrieval-candidates` runs the next-generation base-model matrix against the real hybrid path: expansion + BM25 + sqlite-vec + rerank.
- `bun run eval:retrieval-candidates:write` writes raw artifacts to `evals/fixtures/retrieval-candidate-benchmark/`.
- Outputs include:
  - expansion schema/clean-JSON/entity-loss smoke signals
  - retrieval metrics across baseline, adversarial, multilingual, and ask-style cases
  - answer smoke metrics, latency, and RSS deltas on the local machine
- Use this benchmark before changing the default generation base or starting retrieval fine-tuning work.

## Known Limitations

### Multilingual (38% legacy BM25 score)

`multilingual.eval.ts` is a four-case BM25-only sanity lane over the small
`evals/fixtures/corpus/{de,en,fr,it}` corpus. Despite its historical suite name,
it does not call vector search, test the current Qwen embedding default, or
establish cross-language quality. It documents lexical degradation and does not
gate releases.

Do not mix this score with the separate general-embedding benchmark. The
[immutable April 2026 evidence](fixtures/general-embedding-benchmark/README.md)
uses 15 FastAPI documents in five corpus languages (`en`, `de`, `fr`, `es`,
`zh`) and 13 queries. The later
[July Nemotron screen](../research/embeddings/2026-07-21-nemotron-3-embed-1b.md)
used different runtime/profile paths, so its timings and Qwen scores are not an
update to the April artifact.

Dedicated lexical CJK benchmarking remains pending. Query-language
classification and the seven-language indexed-document detector are product
metadata/prompt features, not evidence that this placeholder eval covers those
languages.

### Ask Eval (61% score)

These historical results cover the three untuned presets; the current built-in
set has four presets because `slim-tuned` is now the default retrieval preset.
The table does not evaluate its fine-tuned `expand` role:

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

- **Evalite vector multilingual lane** - vector/hybrid evidence currently lives
  in the separate general-embedding benchmark harness
- **Lexical CJK benchmark** - tracked separately from the BM25 placeholder
- **Latency budgets** - measure comparable production runtime paths first, then
  set thresholds

## Architecture

```
evals/
├── fixtures/
│   ├── corpus/{de,en,fr,it}/  # Multilingual test documents
│   ├── hybrid-adversarial.json # Entity/phrase/negation/ambiguity cases
│   ├── hybrid-baseline/        # Baseline snapshots (json+md)
│   ├── retrieval-candidate-benchmark/ # Candidate benchmark outputs (json+md)
│   ├── queries.json           # Search queries with relevance judgments
│   └── ask-cases.json         # Answer generation test cases
├── helpers/
│   ├── retrieval-candidate-benchmark.ts # Full candidate benchmark runner
│   ├── retrieval-candidate-matrix.ts    # Candidate matrix + benchmark cases
│   └── setup-db.ts                     # Temp DB creation for evals
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
5. If the work is a manual benchmark rather than an Evalite gate, add a reproducible `scripts/*.ts` entry and artifact directory under `evals/fixtures/`
6. Run `bun run eval:scores` to verify
7. Update this README with status

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
