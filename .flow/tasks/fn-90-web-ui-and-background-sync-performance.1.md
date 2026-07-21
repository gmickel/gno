# fn-90-web-ui-and-background-sync-performance.1 Optimize and coalesce status reads

## Description

Replace correlated status SQL with set-based aggregation, coalesce concurrent status builds, and remove Dashboard's duplicate initial status request while preserving freshness semantics.

## Acceptance

- [ ] Shared mirrors and stale fingerprints retain correct counts.
- [ ] Scale fixture completes warm status below 100ms.
- [ ] Concurrent status callers execute one build.
- [ ] Dashboard performs one initial status request.

## Done summary
Replaced correlated status reads with set-based aggregation, coalesced concurrent builds, and reused dashboard status in the model selector.
## Evidence
- Commits: 0a1db7b
- Tests: status fixture: 56ms for 20k chunks, production /api/status: 295-315ms vs 7.9-9.6s, browser: one status request
- PRs: