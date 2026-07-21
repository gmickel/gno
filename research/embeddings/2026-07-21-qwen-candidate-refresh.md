# Qwen embedding candidate refresh — 2026-07-21

Decision: no newer Qwen model should replace or enter a text-only benchmark
against GNO's `Qwen3-Embedding-0.6B-Q8_0` incumbent today.

## First-party inventory

The Qwen Hugging Face organization currently publishes two embedding families:

- `Qwen3-Embedding`: 0.6B, 4B, and 8B text models, including official GGUFs.
- `Qwen3-VL-Embedding`: 2B and 8B multimodal models released in 2026.

There is no first-party Qwen3.5 or Qwen3.6 embedding checkpoint. The
Qwen3-Embedding-0.6B repository's 2026 update is README-only; it is not a new
weight revision.

## Candidate screen

| Model                 | Newer than incumbent | Size | Dimensions | Languages | Official GGUF | Current decision                                                        |
| --------------------- | -------------------- | ---: | ---------: | --------: | ------------- | ----------------------------------------------------------------------- |
| Qwen3-Embedding-4B    | No                   |   4B |       2560 |      100+ | Yes           | Optional future quality/footprint experiment, not a small-model refresh |
| Qwen3-Embedding-8B    | No                   |   8B |       4096 |      100+ | Yes           | Too large for GNO's local default                                       |
| Qwen3-VL-Embedding-2B | Yes                  |   2B |       2048 |        33 | No            | Future multimodal lane only                                             |
| Qwen3-VL-Embedding-8B | Yes                  |   8B |       4096 |        33 | No            | Too large; future multimodal lane only                                  |

## Why Qwen3-VL-Embedding-2B does not enter the current benchmark

It fails the pre-benchmark product-fit gate:

1. GNO's embedding port and index currently accept text, not image/video or
   mixed-modal inputs. The model's primary advantage therefore cannot be used.
2. Qwen's own MMTEB table reports the 2B VL model slightly below the 0.6B text
   incumbent: mean-by-task `63.87` vs `64.33`, mean-by-type `55.84` vs `56.00`.
3. It has over three times the parameters, twice the vector width, and only 33
   listed languages versus the incumbent's 100+ languages.
4. Qwen publishes the VL checkpoint as Transformers/Safetensors with custom
   multimodal code, not an official GGUF validated by GNO's
   `node-llama-cpp` runtime.

Downloading and adapting it for the existing text fixtures would spend several
gigabytes to test a larger model that is already weaker on the relevant
first-party text benchmark. That is not a useful GNO candidate.

## Watch list

- Revisit `Qwen3-VL-Embedding-2B` when GNO has visual-document/image chunking,
  a multimodal embedding port, and a visual retrieval fixture.
- Revisit `Qwen3-Embedding-4B-GGUF` only if GNO adds a high-quality desktop
  preset with a materially larger memory budget. It is not new, but it is the
  only currently published Qwen text model that might trade footprint for
  higher quality.
- Re-run this inventory when Qwen publishes a sub-2B text embedding generation
  newer than Qwen3-Embedding.

Sources:

- <https://huggingface.co/collections/Qwen/qwen3-embedding>
- <https://huggingface.co/collections/Qwen/qwen3-vl-embedding>
- <https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B>
- <https://github.com/QwenLM/Qwen3-VL-Embedding>
