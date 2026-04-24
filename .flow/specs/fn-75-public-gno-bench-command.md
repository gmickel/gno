# Public gno bench command

## Problem

GNO has strong internal eval/benchmark infrastructure, but no stable user-facing `gno bench` command for teams to measure retrieval quality on their own corpora or fixtures.

QMD 2.1.0 added a small `bench <fixture.json>` command that reports precision, recall, MRR, F1, and latency across BM25/vector/hybrid/full backends. GNO's version should be broader and aligned with existing Evalite/local benchmark infrastructure rather than a direct copy.

## Goals

- Design a public fixture format for retrieval benchmarks.
- Expose a `gno bench <fixture>` CLI command with JSON and terminal output.
- Support backend/mode comparisons that match GNO vocabulary: BM25, vector, hybrid, query depth, expansion, rerank, candidate limit, and query modes.
- Reuse existing benchmark helpers where possible.
- Keep benchmarks local-only and deterministic enough for regression tracking.

## Non-Goals

- Do not block runtime dependency refresh or AST chunking decisions on this epic.
- Do not require LLM-as-judge for the first public command.
- Do not replace the existing `evals/` suite.
