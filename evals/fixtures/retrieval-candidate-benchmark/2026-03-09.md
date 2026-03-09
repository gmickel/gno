# Next-Generation Retrieval Candidate Benchmark

Generated: 2026-03-09T10:11:40.318Z

## Runtime

- Platform: darwin/arm64
- Bun: 1.3.6
- Embed model: `hf:gpustack/bge-m3-GGUF/bge-m3-Q4_K_M.gguf`
- Rerank model: `hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf`
- sqlite-vec available: yes
- Retrieval cases: 45
- Answer smoke cases: 4

## Candidate Matrix

| Candidate                         | Schema | Clean JSON | nDCG@10 | Ask R@5 | Total p95 | RSS delta |
| --------------------------------- | -----: | ---------: | ------: | ------: | --------: | --------: |
| Current shipped slim baseline     |  50.0% |      83.3% |   0.898 |   0.938 |  4727.3ms |  1.21 GiB |
| Current shipped balanced baseline |  83.3% |     100.0% |   0.853 |   0.438 |  2941.4ms |  1.81 GiB |
| Current shipped quality baseline  | 100.0% |     100.0% |   0.744 |   0.250 |  5350.8ms |  2.28 GiB |
| Qwen3.5 0.8B                      |  83.3% |     100.0% |   0.742 |   0.313 |  3971.2ms |  0.99 GiB |
| Qwen3.5 4B                        | 100.0% |     100.0% |   0.737 |   0.188 |  5436.5ms |  2.59 GiB |
| Qwen3.5 9B                        | 100.0% |     100.0% |   0.675 |   0.000 |  6657.1ms |  5.28 GiB |

## Provisional Recommendation

- Expansion winner by measured score: `current-qwen3-1.7b-q4`
- Answer smoke winner: `current-qwen3-4b-q4`
- Reranker path: keep current Qwen3-Reranker unless a later epic lands a realistic drop-in.
