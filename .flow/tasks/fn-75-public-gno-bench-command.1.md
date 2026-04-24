# fn-75-public-gno-bench-command.1 Design and implement public gno bench command

## Description

Create a future public `gno bench <fixture>` command that lets users measure retrieval quality on their own fixtures while reusing GNO's existing local eval/benchmark infrastructure.

This is intentionally separate from the upstream freshness epic. It should be tackled after runtime/dependency freshness and AST chunking decisions are complete.

## Acceptance

- [ ] Design fixture schema with queries, expected documents/URIs, top-k expectations, optional collection, optional query modes, and metadata.
- [ ] Add or update JSON schema/spec docs for bench fixture and bench output.
- [ ] Implement `gno bench <fixture>` with terminal and JSON output.
- [ ] Support comparing useful GNO modes/backends: BM25, vector, hybrid, no-rerank, thorough/query expansion, candidate limit, and query modes.
- [ ] Report retrieval metrics: precision@k, recall@k, MRR, nDCG where practical, F1 if useful, and latency summaries.
- [ ] Reuse existing `evals/` helpers where possible instead of building a parallel framework.
- [ ] Include deterministic example fixture and tests.
- [ ] Document in `docs/CLI.md`, `docs/HOW-SEARCH-WORKS.md` or eval docs, README if user-facing enough, and website docs if applicable.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
