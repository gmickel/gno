# fn-34-evaluate-next-generation-retrieval.1 Benchmark Qwen 3.5 and other candidate local bases

## Description

Run the first benchmark pass for newer local generation bases, starting with practical Qwen 3.5 sizes. The outcome should be a recommendation for which base model `gno` should fine-tune next for query expansion, and whether any rerank experimentation is justified yet.

## Acceptance

- Define the candidate matrix with concrete model URIs and quantizations.
- Benchmark at least the practical Qwen 3.5 sizes first.
- Compare against the currently shipped expansion baseline.
- Report quality, latency, memory, and structured-output reliability.
- Produce a written recommendation naming the preferred next base model.

## Notes For Implementer

- Start with expansion / generation roles first.
- Treat reranker evaluation as optional unless a realistic dedicated ranking candidate exists.
- Use held-out evals and real runtime latency, not only synthetic prompts.
- External references:
  - Andrej Karpathy `autoresearch`: <https://github.com/karpathy/autoresearch>
  - local upstream reference training stack already cloned under `~/repos`
  - official Qwen 3.5 pages for candidate selection

## Done summary

Implemented a reproducible in-repo benchmark for next-generation retrieval generation bases. Added a candidate matrix, full-path benchmark runner, raw artifact snapshots, and a written recommendation memo.

Measured recommendation:

- Keep Qwen3-1.7B-Q4_K_M as the expansion fine-tuning base.
- Keep Qwen3-4B-Instruct-2507-Q4_K_M for answer generation.
- Defer reranker experimentation.

Key results on Apple M4 Max / 128 GiB:

- Qwen3-1.7B delivered the best retrieval quality (nDCG@10 0.898, ask Recall@5 0.938) despite only 50% schema success on smoke prompts.
- Qwen2.5-3B was faster and more structured but worse on retrieval and answer smoke.
- Qwen3.5 0.8B/4B/9B improved JSON cleanliness but all regressed retrieval versus the current 1.7B baseline.

## Evidence

- Commits:
- Tests: bun scripts/retrieval-candidate-benchmark.ts --write, bun run lint:check, bun test, bun run docs:verify
- PRs:
