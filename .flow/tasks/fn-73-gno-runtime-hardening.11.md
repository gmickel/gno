# fn-73-gno-runtime-hardening.11 Profile web UI page-load latency

## Description

Profile slow Web UI navigation against Gordon's production-sized local index. Measure browser waterfalls and server/SQLite phases for Dashboard, Collections, and Browse. Identify root causes, distinguish frontend rerender/network behavior from backend query cost, and recommend the smallest high-leverage fixes. Investigation only unless Gordon separately asks for implementation.

## Acceptance

- [ ] Reproduce current page-load latency with browser and direct API timings.
- [ ] Attribute latency to concrete endpoints, queries, filesystem work, or frontend behavior.
- [ ] Check query plans/indexes and repeated request patterns.
- [ ] Record prioritized fixes with expected impact and verification criteria.

## Done summary

Profiled the production-sized local index and browser waterfalls. /api/status spends ~9.6s in a per-collection correlated embedding freshness query; a set-based equivalent returns identical counts in ~35ms. Dashboard issues two concurrent status requests, serializing to ~16.1s. Background watch syncs run a global typed-edge rebuild on every collection event; this blocked an otherwise 1.8ms docs request for 27.8s and explains the 14m13s full update because syncAll repeats projection for every collection. Static UI and browse APIs are otherwise fast.

## Evidence

- Commits:
- Tests: direct API timing: status 7.9-9.6s, collections <1ms, browse tree 13-19ms, docs 1.8ms idle, browser HAR: collections status 7985ms, JS 63ms; browse tree 16ms, two concurrent status calls: 16.1s wall, optimized set-based status SQL: 34.6ms with identical embedded count, watcher/global graph projection blocked docs request for 27.8s
- PRs:
