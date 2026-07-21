# fn-67-evaluate-qwen3-embedding-06b-gguf-for.6 Record Nemotron comparison and refresh Qwen candidates

## Description

TBD

## Acceptance

- The July 2026 Nemotron 3 Embed comparison is preserved in the tracked embedding benchmark record with model-correct formatting and all measured lanes.
- Current first-party Qwen embedding releases are reviewed for GNO constraints: retrieval quality, multilingual support, size, GGUF/runtime availability, licensing, and prompt compatibility.
- Viable candidates are benchmarked where practical; non-candidates and blockers are documented.
- The default-model recommendation is explicit and evidence-backed.

## Done summary

Preserved the model-correct Nemotron 3 Embed 1B comparison across four retrieval
lanes and kept Qwen3-Embedding-0.6B as the default. Refreshed Qwen's first-party
embedding inventory. The only newer family is Qwen3-VL-Embedding; its 2B model
is larger, text-benchmark-worse, narrower-language, non-GGUF, and unusable for
GNO's current text-only embedding port. Recorded it as a future multimodal
candidate rather than spending a local benchmark on a model that fails the
product-fit gate.

## Evidence

- Commits:
- Tests: Nemotron vs Qwen: multilingual docs, canonical code, GNO src/serve, and public OSS slices, bun run lint:check, bun test
- PRs:
