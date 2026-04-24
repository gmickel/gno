# Future ONNX and Transformers.js runtime evaluation

## Problem

QMD added ONNX conversion work for deploying embedding models through Transformers.js. GNO currently standardizes on GGUF/node-llama-cpp plus optional HTTP-compatible remote endpoints. ONNX/Transformers.js is not an immediate priority, but it may matter later for browser-side search, desktop packaging, lighter embedding installs, or sandboxed runtimes.

This epic is future research and should not alter current runtime defaults unless benchmark/package evidence is strong.

## Goals

- Evaluate whether ONNX/Transformers.js has a credible role in GNO.
- Compare quality, latency, install size, and packaging complexity against current GGUF/node-llama-cpp paths.
- Decide whether this belongs in CLI, Web/Desktop, export tooling, or nowhere for now.

## Non-Goals

- Do not replace GGUF defaults.
- Do not add runtime dependency weight without package-size and install-smoke evidence.
- Do not require cloud APIs.

## Key Context

- Current runtime: `src/llm/nodeLlamaCpp/*`, `src/llm/httpEmbedding.ts`, `src/llm/httpGeneration.ts`, `src/llm/httpRerank.ts`
- Current fine-tune/export docs: `docs/FINE-TUNED-MODELS.md`, `research/finetune/`
- Desktop/runtime context: `desktop/`, `docs/PACKAGING.md`
