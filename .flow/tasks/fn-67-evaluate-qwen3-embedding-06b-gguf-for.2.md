# fn-67-evaluate-qwen3-embedding-06b-gguf-for.2 Run general-collection benchmark lane for Qwen3 vs bge-m3 using the existing retrieval pipeline

## Description

Run the actual comparison using GNO's shipped indexing and retrieval path.

Start here:

- `evals/helpers/code-embedding-benchmark.ts`
- `scripts/code-embedding-benchmark.ts`
- `research/embeddings/README.md`
- `research/embeddings/autonomous/`
- `src/cli/commands/embed.ts`
- `src/serve/context.ts`

Core rule:

- reuse the real pipeline
- do not build a bespoke embedding-only scorer detached from indexing/search

What this task must answer:

- is `Qwen3-Embedding-0.6B-GGUF` better than `bge-m3` for normal markdown/prose collections?
- does that hold for cross-language retrieval too?
- does the answer change for vector-only vs hybrid?

Runtime fairness checks to include:

- confirm native runtime path for Qwen is the intended GGUF path
- confirm pooling behavior required by the model card is actually honored in our runtime, or document that it is not
- compare shipped behavior first; if an instruction-aware variant is explored, report it separately from the shipped baseline

Required outputs:

- baseline artifact for `bge-m3`
- challenger artifact for `Qwen3-Embedding-0.6B-GGUF`
- machine-readable results
- human-readable benchmark summary
- explicit statement of whether outcome is:
  - global-default candidate
  - code-only recommendation
  - inconclusive / no change

Recommended scoring slices:

- vector only
- hybrid
- same-language subset
- cross-language subset

Tests / checks:

- benchmark harness tests for new general fixture family
- one dry-run path in autonomous harness if that lane is extended
- document any runtime caveats uncovered during the run

Docs owned by this task:

- `research/embeddings/README.md`
- new benchmark result pages under the new fixture family
- `website/features/benchmarks.md` if the outcome is worth surfacing immediately

## Acceptance

- [ ] `bge-m3` and Qwen3 are compared on the new public multilingual markdown fixture.
- [ ] Comparison uses GNO's real indexing/search pipeline, not a detached cosine-only script.
- [ ] Results break out vector vs hybrid and same-language vs cross-language behavior.
- [ ] Qwen runtime assumptions that affect fairness are documented.
- [ ] The task ends with a concrete recommendation or an explicit “not enough evidence” call.

## Done summary
Ran the new general-collection benchmark lane through GNO's real indexing and retrieval pipeline.

Delivered:
- added `general-embedding-benchmark` helper and CLI script
- wrote durable baseline + challenger artifacts for `bge-m3` and `Qwen3-Embedding-0.6B-GGUF`
- verified Qwen materially beats the incumbent on the public multilingual markdown fixture
- published vector/hybrid and same-language/cross-language breakdowns
## Evidence
- Commits:
- Tests: bun scripts/general-embedding-benchmark.ts --candidate bge-m3-incumbent --cache-dir /tmp/gno-general-bench-cache --write, bun scripts/general-embedding-benchmark.ts --candidate qwen3-embedding-0.6b --cache-dir /tmp/gno-general-bench-cache --write, bun test test/research/general-embedding-benchmark.test.ts, bun run lint:check
- PRs: