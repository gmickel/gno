# General Embedding Benchmark

Generated: 2026-04-06T13:23:31.949Z
Model: `bge-m3 incumbent`
Embed URI: `hf:gpustack/bge-m3-GGUF/bge-m3-Q4_K_M.gguf`

## Aggregate Metrics

| Mode   | Recall@5 | Recall@10 | nDCG@10 |   MRR | p95 latency |
| ------ | -------: | --------: | ------: | ----: | ----------: |
| Vector |    47.7% |     60.0% |   0.350 | 0.329 |      25.3ms |
| Hybrid |    86.2% |     90.8% |   0.642 | 0.609 |      26.6ms |

## By Case Set

| Set            | Vector nDCG@10 | Hybrid nDCG@10 |
| -------------- | -------------: | -------------: |
| same-language  |          0.292 |          0.672 |
| cross-language |          0.543 |          0.543 |

## Cases

| Case              | Set            | Query lang | Vector nDCG@10 | Hybrid nDCG@10 | Vector p50 | Hybrid p50 |
| ----------------- | -------------- | ---------- | -------------: | -------------: | ---------: | ---------: |
| en-overview-same  | same-language  | en         |          0.301 |          1.000 |     25.3ms |     26.6ms |
| de-overview-same  | same-language  | de         |          0.431 |          0.631 |     20.2ms |     20.0ms |
| fr-overview-same  | same-language  | fr         |          0.631 |          1.000 |     19.4ms |     20.1ms |
| es-overview-same  | same-language  | es         |          0.000 |          0.631 |     18.7ms |     20.4ms |
| zh-overview-same  | same-language  | zh         |          0.500 |          0.500 |     19.1ms |     20.4ms |
| en-features-same  | same-language  | en         |          0.000 |          0.631 |     18.8ms |     19.4ms |
| de-features-same  | same-language  | de         |          0.000 |          0.631 |     18.1ms |     18.3ms |
| fr-features-same  | same-language  | fr         |          0.000 |          0.631 |     18.4ms |     19.3ms |
| es-async-same     | same-language  | es         |          0.631 |          0.631 |     18.3ms |     18.6ms |
| zh-async-same     | same-language  | zh         |          0.431 |          0.431 |     18.2ms |     18.4ms |
| pt-overview-cross | cross-language | pt         |          0.698 |          0.698 |     17.7ms |     18.0ms |
| it-features-cross | cross-language | it         |          0.170 |          0.170 |     17.3ms |     17.9ms |
| pt-async-cross    | cross-language | pt         |          0.762 |          0.762 |     16.8ms |     17.6ms |
