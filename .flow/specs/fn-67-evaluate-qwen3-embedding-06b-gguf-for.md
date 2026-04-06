# fn-67-evaluate-qwen3-embedding-06b-gguf-for Evaluate Qwen3-Embedding-0.6B-GGUF for general multilingual collections

## Overview

Determine whether `Qwen3-Embedding-0.6B-GGUF` is better than the current `bge-m3` default for normal markdown/prose collections, not just code-heavy collections.

This epic should reuse GNO's real indexing + retrieval pipeline, avoid any Gordon/private content, and build a reproducible multilingual benchmark lane from public markdown sources.

It must also answer the operator question that blocks any future default change:

- if the global embedding model changes, what is the clean reindex story in CLI, API, and web UI?

## Scope

Included:

- a reproducible multilingual markdown benchmark fixture built from public OSS/public-doc markdown
- benchmark runs comparing `Qwen3-Embedding-0.6B-GGUF` vs `bge-m3` on normal collections
- use of the real GNO indexing/search pipeline rather than bespoke cosine-only experiments
- explicit evaluation of same-language and cross-language retrieval quality
- design of clean reindex/status semantics when the active global embed model changes
- docs/website updates for the outcome if evidence is strong enough

Excluded:

- any Gordon/private or non-OSS content
- code-specific benchmark work; already covered by the code embedding lane
- switching defaults before evidence exists
- reranker/generation model changes
- path/file-type override design; covered by `fn-65`

## Approach

### Prior context

- Current default embed model in presets is `bge-m3`:
  - `src/config/types.ts`
- GNO already has a code-embedding benchmark/autoresearch lane:
  - `evals/helpers/code-embedding-benchmark.ts`
  - `evals/fixtures/code-embedding-benchmark/`
  - `research/embeddings/README.md`
- Existing local findings say Qwen is strong for code, but that is not enough to justify a global default change for prose/mixed collections.
- Public model-card claims for `Qwen3-Embedding-0.6B-GGUF` matter here:
  - 100+ languages
  - instruction-aware retrieval
  - llama.cpp guidance uses `--pooling last`
    Source: [Qwen model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF)

### Reuse anchors

- default presets: `src/config/types.ts:188`
- active preset switching:
  - `src/cli/commands/models/use.ts:27`
  - `src/serve/routes/api.ts:3194`
- embed backlog is model-aware:
  - `src/store/vector/stats.ts:49`
  - `src/cli/commands/embed.ts:321`
- top-level app status/backlog is not yet model-aware:
  - `src/store/sqlite/adapter.ts:2773`
- web server context binds embed/vector to the active preset embed URI:
  - `src/serve/context.ts:93`
  - `src/serve/context.ts:115`
- current code benchmark helper: `evals/helpers/code-embedding-benchmark.ts:1`
- benchmark/autonomous docs:
  - `research/embeddings/README.md`
  - `website/features/benchmarks.md`

### Product stance

- evaluate Qwen against the shipped baseline as GNO actually runs today
- do not use private content
- keep the benchmark reproducible offline after fixture vendoring/materialization
- multilingual retrieval matters; benchmark must not collapse to English-only prose
- if Qwen only wins with product changes we do not support yet, capture that separately instead of counting it as a clean default win

### Deliverables

#### 1. Public multilingual markdown fixture

- build a new general-collection benchmark fixture from public markdown sources
- vendor or pin sources so runs do not depend on Gordon/private content
- include source provenance and license info
- include at least:
  - same-language retrieval cases
  - cross-language retrieval cases
  - concept/factual doc lookup
  - entity-heavy doc lookup

#### 2. General-collection benchmark lane

- reuse the existing indexing/embedding/search pipeline
- compare at minimum:
  - vector retrieval quality
  - hybrid retrieval quality
- run `bge-m3` baseline and `Qwen3-Embedding-0.6B-GGUF`
- verify runtime assumptions that materially affect fairness:
  - pooling mode
  - query/doc formatting
  - whether instruction-aware behavior is supported or intentionally out-of-scope for the shipped comparison

#### 3. Global-model reindex semantics

- define the clean operator flow when global embed model changes
- likely areas to decide:
  - when status should show new embedding backlog
  - how preset switching should communicate vector-state mismatch
  - whether plain `gno embed` is sufficient or whether we need a guided reindex action
  - whether stale old-model vectors stay until explicit cleanup
- this epic must produce a concrete recommended behavior even if implementation is deferred

#### 4. Outcome publication

- if Qwen materially wins on general multilingual collections, publish that clearly
- if it does not, publish that too and keep `bge-m3` as the recommended default
- any recommendation must state whether it applies to:
  - global default
  - code collections only
  - mixed/prose collections only

### Risks / traps

- accidentally benchmarking a private corpus
- overfitting to English README-style prose
- letting BM25 dominate the score so embedding changes are impossible to see
- treating instruction-aware improvements as product wins if the shipped pipeline does not expose them
- changing the global model story without a clear reindex/status experience

### Task breakdown

#### Task 1

`fn-67-evaluate-qwen3-embedding-06b-gguf-for.1`

Create multilingual public markdown benchmark fixtures for general collections.

#### Task 2

`fn-67-evaluate-qwen3-embedding-06b-gguf-for.2`

Run the general-collection benchmark lane for Qwen vs `bge-m3` using the existing retrieval pipeline.

#### Task 3

`fn-67-evaluate-qwen3-embedding-06b-gguf-for.3`

Design clean reindex semantics for global embedding model changes.

#### Task 4

`fn-67-evaluate-qwen3-embedding-06b-gguf-for.4`

Publish the benchmark outcome and the default-model recommendation only if warranted by the evidence.

## Quick commands

- `bun run lint:check`
- `bun test`
- `bun run docs:verify`
- `bun run website:sync-docs`
- `bun run bench:code-embeddings --candidate bge-m3-incumbent --fixture oss-slices --dry-run`

## Acceptance

- [ ] A public multilingual markdown benchmark fixture exists with pinned provenance and no private content.
- [ ] Qwen3 and bge-m3 are compared through GNO's real indexing/search pipeline for normal collections.
- [ ] The result distinguishes same-language vs cross-language retrieval and vector vs hybrid behavior.
- [ ] The epic produces a concrete recommended reindex/status flow for global embedding model changes.
- [ ] Docs and benchmark pages clearly say whether Qwen should stay code-only, become a global recommendation, or remain experimental.

## References

- `src/config/types.ts`
- `src/cli/commands/models/use.ts`
- `src/cli/commands/embed.ts`
- `src/store/vector/stats.ts`
- `src/store/sqlite/adapter.ts`
- `src/serve/context.ts`
- `evals/helpers/code-embedding-benchmark.ts`
- `evals/fixtures/code-embedding-benchmark/`
- `research/embeddings/README.md`
- `website/features/benchmarks.md`
- `docs/CONFIGURATION.md`
- `docs/USE-CASES.md`
