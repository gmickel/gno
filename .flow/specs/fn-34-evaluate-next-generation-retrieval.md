# Evaluate Next-Generation Retrieval Model Bases

## Goal

Choose the best next base model(s) for `gno` before doing any fine-tuning work.

## Start Here

A new agent should be able to execute this epic cold in this order:

1. inspect the currently shipped model presets and runtime behavior in `gno`
2. define the candidate matrix with exact model URIs and quantizations
3. wire or reuse a reproducible benchmark harness
4. run the benchmark and save raw artifacts
5. write a recommendation naming the next base to fine-tune

## Why This Comes First

Fine-tuning on the wrong base wastes time and compute. The first job is to measure whether newer candidate families materially outperform the current shipped presets on the axes that matter to `gno`:

- structured query-expansion quality
- retrieval lift on held-out evals
- latency
- memory footprint
- local usability on realistic hardware

## Current Product Baseline

- Expansion / answer generation currently uses small Qwen-family local models.
- Reranking currently uses a dedicated reranker path.
- Runtime is `node-llama-cpp@3.17.1` with `build: "autoAttempt"`.

The benchmark should compare candidates against the exact shipped behavior, not against an abstract paper baseline.

## Scope

Benchmark candidate generation models first. Candidate rerank models should only be included if they are realistic drop-in options for the current rerank path.

Priority order:

1. Qwen 3.5 small local candidates for query expansion
2. Qwen 3.5 medium local candidates for query expansion
3. Only then, evaluate rerank alternatives if a dedicated ranking model exists and the runtime path is realistic

## Required Candidate Matrix

The benchmark must define exact URIs and quantizations, not just family names.

Minimum generation candidates:

- current shipped expansion model
- Qwen 3.5 `0.8B`
- Qwen 3.5 `4B`
- Qwen 3.5 `9B` if local inference is still practical

For each candidate, record:

- model URI
- quantization
- role tested (`expand`, optionally `answer`)
- expected RAM / VRAM footprint
- whether it supports clean non-thinking / structured output behavior in our runtime

Rerank candidates are optional in this epic. If no realistic dedicated rerank model is ready, keep the current reranker and document that decision.

## External References

Use these as inputs so the next agent does not need to rediscover them:

- Andrej Karpathy `autoresearch`: <https://github.com/karpathy/autoresearch>
- local upstream reference training stack already cloned under `~/repos`
- official Qwen 3.5 model pages:
  - <https://huggingface.co/Qwen/Qwen3.5-0.8B>
  - <https://huggingface.co/Qwen/Qwen3.5-4B>
  - <https://huggingface.co/Qwen/Qwen3.5-9B>

These are research inputs only. Promotion decisions must be based on measured `gno` results.

## Required Benchmark Outputs

The benchmark must report:

- expansion schema success rate
- retrieval quality on current evals
- latency by stage
- median / p95 end-to-end query latency
- memory use / model load behavior
- subjective failure modes:
  - verbosity
  - thought leakage
  - entity loss
  - negation drift
  - multilingual degradation

## Required Eval Inputs

Use existing repo evals as the backbone and add a clearly labeled candidate-benchmark harness if needed.

Must include:

- ambiguous queries
- entity-heavy technical queries
- negation / exclusion-sensitive queries
- multilingual queries
- Ask-style retrieval cases, not just search-only cases

Strong preference:

- keep the benchmark harness in-repo and reproducible
- save both aggregate summaries and raw per-model outputs
- make it easy to rerun after runtime or prompt changes

## Deliverables

- benchmark matrix file or script config
- reproducible benchmark command(s)
- benchmark results artifact committed or saved in a documented location
- recommendation memo:
  - preferred base for expansion
  - preferred base for answer generation, if different
  - whether rerank experimentation should proceed now or later

## Decision Rules

Do not promote a new base only because it is “smarter.”

Promote only if it shows a defensible win on:

- quality or robustness
- without unacceptable latency / memory regressions

If a larger model is better but too slow for default local UX, document it as a non-default research path, not the new default.

## Acceptance

- Exact candidate matrix defined with concrete URIs and quantizations
- Qwen 3.5 candidates benchmarked first for generation/expansion roles
- Benchmarks cover quality, latency, and memory
- Recommendation names the preferred base to fine-tune next
- Recommendation explicitly states whether reranker work should start now or remain deferred

## Handoff Notes

- Do not start fine-tuning in this epic.
- If a candidate cannot be run locally with current tooling, document the blocker explicitly instead of silently skipping it.
- If benchmarking requires runtime/tooling updates, land those first and re-run the matrix.
