# fn-80-cpu-embedding-autoresearch-and.1 Benchmark and optimize CPU embedding path

## Description

TBD

## Acceptance

- [ ] TBD

## Done summary

Implemented CPU embedding autoresearch harness and adjusted Windows CPU context defaults.

- Added `bun run bench:cpu-embeddings` synthetic native-async context benchmark.
- Changed Windows CPU context heuristic: <16GB -> 1, 16GB-<24GB -> 2, >=24GB -> adaptive up to 4.
- Updated docs/changelog and regression tests.
- Benchmark evidence: 2 contexts ~1.98x, 4 contexts ~3.98x vs one context in synthetic native-async scheduling model.

## Evidence

- Commits:
- Tests:
- PRs:
