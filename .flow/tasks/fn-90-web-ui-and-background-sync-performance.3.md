# fn-90-web-ui-and-background-sync-performance.3 Make watcher sync path incremental

## Description

Use reported watcher paths instead of full collection scans. Handle add/change/delete, reproject changed sources and known backlink sources, and preserve full sync as the exact reconciliation boundary.

## Acceptance

- [ ] Watch flush calls path sync, not syncCollection.
- [ ] Changed files process without walking unrelated files.
- [ ] Deleted files become inactive.
- [ ] Changed and backlink source typed edges update.
- [ ] Watch callback/result tests cover add/change/delete.

## Done summary
Watcher batches now sync only changed paths, mark deletions inactive, and reproject changed sources plus known backlinks without walking collections.
## Evidence
- Commits: 0a1db7b
- Tests: test/ingestion/sync-incremental.test.ts, test/serve/watch-service.test.ts
- PRs: