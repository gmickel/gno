# fn-90-web-ui-and-background-sync-performance.4 Keep projection responsive and verify production timings

## Description

Bound/yield typed-edge projection work so Bun.serve can answer unrelated requests, then capture production-scale before/after timings for status, watcher, full sync, and API responsiveness.

## Acceptance

- [ ] Projection yields at a tested bounded interval.
- [ ] Unrelated API work completes during large projection.
- [ ] Production timing evidence demonstrates material improvement.
- [ ] Remaining costs and reconciliation boundary are documented.

## Done summary
Projection yields cooperatively; production browser navigation and API timing confirm responsive reads during reconciliation and fast steady-state Browse.
## Evidence
- Commits: 0a1db7b
- Tests: projection yield regression, Collections status 293ms, Browse tree 32ms and docs 10ms, full update 46.1s
- PRs: