---
satisfies: [R1, R2, R3, R4]
---
# fn-205-gno-serve-misses-changes-made-while-it.1 Reconcile watched collections when gno serve starts

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
`gno serve` never reconciled its collections with the disk at startup: the watch service's first start only built a snapshot baseline ("Initial start (no prior fingerprint): snapshot only - no full sync" in watch-service-lifecycle.ts), so notes added, edited or deleted while no resident ran stayed out of the index. `gno daemon` was unaffected because it runs `runtime.syncAll` itself unless `--no-sync-on-start`. The watch service now takes a `reconcileOnStart` option; when set, `start()` queues one generation reconcile per collection whose watcher started. It runs once the snapshot baseline is ready, through the normal flush path, so it inherits the no-wait write lease (fixed retry when held), the failure backoff, and source availability via `syncCollection`. The resident runtime sets it for `serve` only. Docs: WEB-UI.md (Background Reliability), DAEMON.md (daemon vs serve), CHANGELOG Unreleased Fixed.

Defect route:
- prior fixes: none (git log on watch-service-lifecycle.ts; bug memory filed by fn-203)
- diagnosis: reproduced with test/serve/resident-startup-reconcile.test.ts (restart left deleted.md indexed and both added notes missing after 15 s); located the lifecycle branch that skips a full sync on first fingerprint; the daemon's catch-up comes from daemon.ts syncAll, not the watcher
- introduced by: skipped: behaviour present since the shared watcher landed; no known-good revision for serve
- base: 6bfaf208 resident-startup-reconcile serve case fails | head: 67e0f620 passes; watch-service-startup-reconcile.test.ts 4 pass
- live: real `gno serve` probe (50 indexed, +20/-1 while stopped): main stays at 50 docs for 30 s; fix converges to 69 in ~730 ms with /api/status answering in 9-14 ms
- live: soak torture signals seed 3: I8/I9 pass (base runs: missing ~287-577 notes after SIGHUP/SIGKILL restarts)

R1 serve reconciles each watched collection at startup in the background; status answered in 9 ms right after restart. R2 resident-startup-reconcile.test.ts covers adds, edits, deletes made while stopped; live probe converges in under 1 s. R3 soak torture signals seed 3: I8 9/9 and I9 6/6 pass. R4 runs through the watcher flush path; unit test shows a failing startup reconcile backs off (2-3 attempts in 2.7 s), unwatchable collections queue nothing.

Remaining soak failures in that run belong elsewhere: I4 status latency under burst (fn-208); I3 holder sidecar after SIGHUP mid-burst (no SIGHUP handler; pre-existing, filed separately).

stage: impl-review - skipped(policy: repo instructions skip all review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 6bfaf20853c6a1ded1a3596fd86dbc7d4a162e1f, 67e0f6205b37ff1b06288dd4642ea862fe501e22
- Tests: bun run lint:check && bun test
- PRs: