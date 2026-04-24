# Future external retrieval eval corpus expansion

## Problem

GNO has local evals and benchmark fixtures, plus imported QMD fine-tune data snapshots. The QMD release/check also surfaced small retrieval eval fixtures and hard-query examples that could improve regression coverage if imported carefully.

This is future work because runtime freshness, dependency policy, MCP ergonomics, and AST benchmarking are higher priority. The important principle is curation: external fixtures should raise signal, not dump noisy data into tests or training.

## Goals

- Curate external retrieval eval cases into GNO's eval suite or future `gno bench` examples.
- Prefer small, explainable fixtures with expected-doc judgments and edge-case coverage.
- Preserve provenance and licensing notes.
- Avoid raw/noisy training data imports unless filtered and justified.

## Non-Goals

- Do not retrain models in this epic.
- Do not replace existing GNO evals.
- Do not import public-facing references to QMD docs/product copy.

## Key Context

- Existing evals: `evals/`, `spec/evals.md`
- Existing finetune import notes: `research/finetune/README.md`
- Existing training mix epic: `fn-38-optimize-retrieval-training-data-mixes`
- Future public bench epic: `fn-75-public-gno-bench-command`
