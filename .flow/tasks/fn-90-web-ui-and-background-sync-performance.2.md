# fn-90-web-ui-and-background-sync-performance.2 Project typed edges once per full sync

## Description

Separate collection ingestion from typed-edge projection so syncAll performs one exact global reconciliation after all collections are ingested.

## Acceptance

- [ ] syncAll invokes global projection exactly once.
- [ ] Standalone syncCollection still reconciles graph edges.
- [ ] Projection errors remain in sync results.
- [ ] Existing graph tests retain parity.

## Done summary
syncAll defers typed-edge projection until every collection completes, then runs one exact global reconciliation.
## Evidence
- Commits: 0a1db7b
- Tests: sync-incremental projection-count regression, production full update: 46.1s vs 14m13s
- PRs: