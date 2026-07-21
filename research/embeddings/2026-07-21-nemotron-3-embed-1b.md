# Nemotron 3 Embed 1B evaluation — 2026-07-21

Decision: keep `Qwen3-Embedding-0.6B-Q8_0` as GNO's default embedding model.
Nemotron 3 Embed 1B did not improve the multilingual retrieval lane and only
showed a small, low-sample gain on one GNO code slice.

## Test setup

- Candidate: `nvidia/Nemotron-3-Embed-1B-BF16`
- Incumbent: `Qwen/Qwen3-Embedding-0.6B-GGUF`, Q8_0
- Candidate runtime: local PyTorch HTTP adapter
- Candidate formatting: `query: ` for queries, `passage: ` for documents,
  mean pooling, L2 normalization
- Incumbent runtime: GNO's production `node-llama-cpp` GGUF path
- Date: 2026-07-21

The HTTP adapter was necessary to preserve Nemotron's model-card contract.
Testing it through GNO's generic embedding profile would have produced an
invalid comparison because the required query/document prefixes differ.

## Results

| Lane                   | Queries | Qwen vector nDCG@10 | Nemotron vector nDCG@10 | Qwen hybrid nDCG@10 | Nemotron hybrid nDCG@10 |
| ---------------------- | ------: | ------------------: | ----------------------: | ------------------: | ----------------------: |
| Multilingual docs      |      13 |              0.9891 |                  0.9023 |              0.9891 |                  0.9461 |
| Canonical code         |      10 |              0.9631 |                  0.9631 |              1.0000 |                  1.0000 |
| GNO `src/serve`        |       3 |              0.8102 |                  0.8333 |              0.8102 |                  0.8333 |
| Public OSS code slices |       8 |              1.0000 |                  1.0000 |              1.0000 |                  1.0000 |

Candidate indexing completed without embedding errors in all four lanes. The
multilingual lane embedded 98 chunks in 71.47 seconds. The `src/serve` lane
embedded 391 chunks in 287.37 seconds. Those timings describe the temporary
PyTorch adapter and are not comparable to GNO's production GGUF latency.

## Product-fit assessment

- Nemotron: 1.14B parameters, 2048 dimensions, 32K advertised context, 34
  languages, official BF16 checkpoint about 2.28 GB.
- Qwen incumbent: 0.6B parameters, 1024 dimensions, 100+ languages, production
  Q8 GGUF about 639 MB.
- Nemotron's official deployment paths are PyTorch, vLLM, and NIM. This test did
  not validate an official GGUF artifact with GNO's `node-llama-cpp` runtime.
- A switch would double vector width, increase model memory/storage, require a
  new compatibility profile, and force re-embedding while reducing measured
  multilingual quality.

## Recommendation

No default-model change. Keep Nemotron 3 Embed 1B outside the active autonomous
candidate set until both conditions hold:

1. an official or otherwise trusted GGUF runs reliably through
   `node-llama-cpp`; and
2. a larger code benchmark confirms the +0.0231 `src/serve` nDCG@10 signal
   without losing general multilingual quality.

Sources:

- <https://huggingface.co/nvidia/Nemotron-3-Embed-1B-BF16>
- <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B>
