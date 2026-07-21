# fn-73-gno-runtime-hardening.13 Make typed-edge projection incremental and non-blocking

## Description

Stop running global typed-edge backfill and all-document projection inside every syncCollection call. Full sync should project once after collection ingestion; watch/path sync should update only affected source/target edges or schedule bounded projection outside the Bun.serve request thread. Preserve graph semantics and failure reporting.

## Acceptance

- [ ] syncAll performs at most one global graph projection rather than once per collection.
- [ ] A one-file watcher event does not walk/project every document globally.
- [ ] Web health/docs/browse requests remain responsive during watcher projection.
- [ ] Current typed-edge, wikilink, relation, and graph traversal tests retain parity.
- [ ] Production-scale full update materially improves from the measured 853.6s baseline; stage timings identify remaining cost.

## Done summary
Revalidated and implemented under fn-90.2-.4: one full-sync projection, incremental watcher sync, scoped backlink refresh, and cooperative yields.
## Evidence
- Commits: 0a1db7b
- Tests: production full update 46.1s vs 14m13s, Browse tree 32ms, docs 10ms
- PRs: