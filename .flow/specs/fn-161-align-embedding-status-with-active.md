# Fix embedding status after vector variant activation

## Goal and context
The default index reports 241 pending chunks in CLI and web status while `gno embed` and its dry run report zero pending. SqliteAdapter.getStatus counts legacy content_vectors even after verified vector variants become authoritative.

## Acceptance Criteria
- **R1:** Shared status backlog and per-collection embedded counts follow the current authoritative embedding storage, model and input identity. Complete active variants report no false backlog; changed/missing owners remain pending. Preserve legacy fallback for indexes not using verified variants and explicit model filtering.
- **R2:** Handle shared content across documents/collections, title changes, inactive documents, model/partition changes and incomplete/stale activation without claiming readiness incorrectly. Status is read-only and must not load native models or rewrite vectors.
- **R3:** CLI and web/API status reflect the corrected shared counts. Cover meaningful regression cases using isolated fixtures, including stale legacy vectors alongside complete variants. Keep existing output schema unless a change is essential.
- **R4:** Document the corrected meaning, run focused and full release gates plus live CLI/API QA, and publish a patch release. Preserve all real documents/index data; no forced reembedding or production database repair.

## Boundaries
Shared SQLite/vector status helper, focused tests, status consumers only as required, affected documentation and changelog. No retrieval algorithm changes, dependency upgrades, legacy table deletion or unrelated cleanup.

## Quick commands
`bun test test/store` and affected status/variant suites discovered during implementation; `bun run lint:check`.

## Release verification
Frozen dependency install; release checklist in .github/CONTRIBUTING.md; package/clipper validation; actual CLI/API status against isolated variant fixture and read-only existing index; CI and coordinated publication artifacts.
