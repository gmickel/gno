# fn-73-gno-runtime-hardening.12 Optimize and deduplicate Web UI status reads

## Description

Replace the correlated per-collection embedding freshness scan in SqliteAdapter.getStatus with a set-based aggregation over distinct active collection/mirror pairs. Preserve fingerprint-aware freshness semantics. Remove redundant full-status reads from AIModelSelector or share/coalesce them, and add bounded server-side snapshot/in-flight caching with explicit invalidation only if still useful after the SQL fix.

## Acceptance

- [ ] Status collection/chunk/embedded/backlog counts retain contract-test parity, including shared mirrors and stale fingerprints.
- [ ] Production-scale status query falls from ~9.6s to under 100ms warm.
- [ ] Dashboard does not issue duplicate full-status requests; concurrent callers are deduplicated.
- [ ] Collections and Dashboard complete their data load without blocking unrelated API requests.
- [ ] Regression/performance fixture covers at least 20 collections and tens of thousands of historical chunks.

## Done summary
Revalidated and implemented under fn-90.1: set-based status aggregation, request coalescing, and duplicate dashboard fetch removal.
## Evidence
- Commits: 0a1db7b
- Tests: status fixture 56ms, production status 295-315ms, browser single status request
- PRs: