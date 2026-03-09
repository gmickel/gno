# fn-34 Recommendation

Generated from:

- `evals/fixtures/retrieval-candidate-benchmark/latest.json`
- `evals/fixtures/retrieval-candidate-benchmark/latest.md`

Run date: 2026-03-09
Host: Apple M4 Max, 128 GiB RAM
Runtime path: `expandQuery` + BM25 + sqlite-vec + `Qwen3-Reranker-0.6B`

## Recommendation

- Expansion fine-tuning base: keep `hf:unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf`
- Answer-generation base: keep `hf:unsloth/Qwen3-4B-Instruct-2507-GGUF/Qwen3-4B-Instruct-2507-Q4_K_M.gguf`
- Rerank work: defer; keep current reranker path

## Why

- `Qwen3-1.7B` still produced the best measured retrieval quality on this stack:
  - overall `nDCG@10 = 0.898`
  - ask-style `Recall@5 = 0.938`
  - adversarial `nDCG@10 = 0.975`
  - multilingual `nDCG@10 = 0.819`
- No Qwen3.5 candidate beat it on retrieval. Newer/larger models improved JSON cleanliness, but they regressed the thing that matters here: which documents surfaced for real hybrid retrieval.
- `Qwen3-4B-Instruct-2507` stayed clearly best for grounded answer smoke:
  - topic hit rate `0.738`
  - citation rate `1.0`
  - valid citation rate `1.0`

## Interpreting The Tradeoff

- `Qwen3-1.7B` is messy on structured expansion output:
  - schema success only `50%` on the smoke set
  - failures were truncation/empty-output cases, not thought leakage
- Despite that, end-to-end retrieval was still strongest. That implies fn-35 should focus on fixing structured expansion reliability on the current base before spending time on a base migration.
- `Qwen2.5-3B` is the strongest fallback if structured-output reliability becomes the top priority:
  - faster p95 (`2941ms`)
  - much better schema success (`83.3%`)
  - but worse overall retrieval and much worse answer smoke
- `Qwen3.5-0.8B` is viable only for an aggressive memory budget:
  - lowest RSS delta (`~0.99 GiB`)
  - retrieval materially below current `1.7B`
- `Qwen3.5-4B` and `Qwen3.5-9B` were clean but not better:
  - slower
  - worse ask-style retrieval
  - no answer-smoke advantage over current `Qwen3-4B`

## What fn-35 Should Do

- Start the fine-tuning sandbox with `Qwen3-1.7B-Q4_K_M` as the primary expansion base.
- Optimize for:
  - strict JSON adherence
  - truncation resistance on entity-heavy and negation-sensitive prompts
  - preserving quoted phrases and exclusions without sacrificing retrieval lift
- Keep one secondary lane for `Qwen2.5-3B-Q4_K_M` only if the sandbox shows the `1.7B` base cannot be made reliably structured.

## Rerank Decision

- Do not start reranker experimentation yet.
- This epic did not identify a realistic drop-in rerank candidate with a stronger end-to-end case than the current dedicated reranker.
- Better sequencing:
  1. stabilize expansion on the winning base
  2. measure post-fine-tune lift
  3. revisit rerank only if retrieval bottlenecks remain
