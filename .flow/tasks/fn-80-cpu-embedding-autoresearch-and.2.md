# fn-80-cpu-embedding-autoresearch-and.2 Add real CPU embedding benchmark path

## Description

Add a real-model mode to the CPU embedding autoresearch benchmark so context
pool variants can be measured through production model/cache/embedding code.

## Acceptance

- [x] Script can still run synthetic scheduler benchmark without a cached model.
- [x] Script can benchmark a real cached or downloaded GGUF embedding model.
- [x] Output separates init/load time from timed embedding throughput.
- [x] Docs/changelog mention the real-path benchmark mode.

## Done summary

Added --real mode to the CPU embedding autoresearch script so benchmark variants can run through LlmAdapter, ModelCache, NodeLlamaCppEmbedding, and node-llama-cpp with cached/downloaded GGUF models. Updated AGENTS and changelog.

- Real-path local evidence: 1 context 66.4 chunks/s, 2 contexts 67.6 chunks/s,
  4 contexts 68.7 chunks/s on the cached default GGUF model. On this machine,
  extra contexts were effectively flat, so real-path data should drive future
  tuning decisions over synthetic scheduler data.
- Follow-up iteration: production now pre-tokenizes embedding inputs to avoid
  duplicate tokenization, avoids a duplicate vector array copy, caps automatic
  CPU contexts at two while preserving `GNO_EMBED_CONTEXTS=4` as an explicit
  override, and exposes real benchmark knobs for context size and threads.
  512-chunk evidence after the cap: 1 context 71.7 chunks/s, 2 contexts 72.3
  chunks/s, explicit 4 contexts 71.3 chunks/s.

## Evidence

- Commits:
- Tests:
  - `bun run bench:cpu-embeddings -- --chunks 32 --delay-ms 5 --dimensions 16`
  - `bun run bench:cpu-embeddings -- --real --chunks 32 --warmup 4 --contexts 1,2,4`
  - `bun test test/llm/embedding.test.ts test/embed/batch.test.ts test/embed/backlog.test.ts`
  - `bun run lint:check`
  - `bun run typecheck`
  - `bun run docs:verify`
  - `bun test`
- PRs:
