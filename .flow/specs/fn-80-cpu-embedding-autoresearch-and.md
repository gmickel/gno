# CPU Embedding Autoresearch and Optimization

## Goal & Context

Investigate and optimize GNO's CPU embedding path after issue #115 showed CPU-only embedding can be unusably slow on Windows-era Ryzen hardware. Build a repeatable local autoresearch script that benchmarks the embedding pipeline and use it to validate changes.

## Architecture & Data Models

The work targets the shared embedding batch pipeline and CLI embedding command. The benchmark should isolate pipeline overhead and concurrency behavior without requiring real GPU hardware. Changes should preserve embedding recovery semantics, vector storage behavior, and existing CLI/API/MCP contracts.

## API Contracts

No public output schema changes unless required. Existing `gno embed` flags stay compatible. Any new env/options must be documented.

## Edge Cases & Constraints

Do not regress batch fallback, disposed-context recovery, low-memory Windows safety, or vector index syncing. CPU improvements must not force high RAM use by default. Benchmarks must be deterministic enough for local comparison.

## Acceptance Criteria

- [ ] Add a repeatable autoresearch/benchmark script for CPU embedding pipeline variants.
- [ ] Identify at least one measurable CPU-path improvement or document why none is safe.
- [ ] Add regression tests around changed embedding behavior.
- [ ] Run focused tests, full tests, lint/typecheck, and docs verification.

## Boundaries

Do not add new third-party dependencies. Do not require actual CUDA/Vulkan hardware for the benchmark. Do not replace the default embedding model in this task unless evidence strongly supports it.

## Decision Context

A GPU remains the real solution for large transformer embeddings, but GNO should avoid avoidable CPU-side overhead and provide evidence-backed defaults.
