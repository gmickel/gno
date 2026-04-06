# General Embedding Benchmark

Generated: 2026-04-06T13:24:22.734Z
Model: `Qwen3 Embedding 0.6B`
Embed URI: `hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf`

## Aggregate Metrics

| Mode   | Recall@5 | Recall@10 | nDCG@10 |   MRR | p95 latency |
| ------ | -------: | --------: | ------: | ----: | ----------: |
| Vector |    93.8% |     96.9% |   0.859 | 0.846 |     399.8ms |
| Hybrid |    93.8% |     96.9% |   0.947 | 0.962 |     384.4ms |

## By Case Set

| Set            | Vector nDCG@10 | Hybrid nDCG@10 |
| -------------- | -------------: | -------------: |
| same-language  |          0.849 |          0.963 |
| cross-language |          0.893 |          0.893 |

## Cases

| Case              | Set            | Query lang | Vector nDCG@10 | Hybrid nDCG@10 | Vector p50 | Hybrid p50 |
| ----------------- | -------------- | ---------- | -------------: | -------------: | ---------: | ---------: |
| en-overview-same  | same-language  | en         |          0.431 |          1.000 |    399.8ms |    384.4ms |
| de-overview-same  | same-language  | de         |          1.000 |          1.000 |    357.4ms |    331.3ms |
| fr-overview-same  | same-language  | fr         |          1.000 |          1.000 |    306.6ms |    290.9ms |
| es-overview-same  | same-language  | es         |          1.000 |          1.000 |    290.4ms |    284.0ms |
| zh-overview-same  | same-language  | zh         |          0.631 |          0.631 |    283.3ms |    292.6ms |
| en-features-same  | same-language  | en         |          0.431 |          1.000 |    286.2ms |    288.9ms |
| de-features-same  | same-language  | de         |          1.000 |          1.000 |    285.6ms |    272.3ms |
| fr-features-same  | same-language  | fr         |          1.000 |          1.000 |    289.8ms |    296.1ms |
| es-async-same     | same-language  | es         |          1.000 |          1.000 |    289.4ms |    300.7ms |
| zh-async-same     | same-language  | zh         |          1.000 |          1.000 |    298.6ms |    290.1ms |
| pt-overview-cross | cross-language | pt         |          0.943 |          0.943 |    277.7ms |    282.5ms |
| it-features-cross | cross-language | it         |          0.869 |          0.869 |    283.0ms |    283.1ms |
| pt-async-cross    | cross-language | pt         |          0.869 |          0.869 |    284.9ms |    282.9ms |
