---
satisfies: [R3, R6]
---
# fn-132-wired-loop-capture-parity-changes.4 Scheduled findings pass in daemon

## Description
Scheduled findings pass (audit only). **Size:** M. **Files/Touches:** daemon task loop (src/serve/resident-runtime.ts area), src/config/types.ts (new `findings` config block), findings record writer, docs (daemon section + CONFIGURATION.md), tests.
DESCOPED per plan review: saved-Capsule reverification stays on its existing journal-driven scheduler and is NOT part of this pass (calling it on cadence is a no-op by design — src/core/capsule-reverification-scheduler.ts). This task = scheduled READ-ONLY `gno audit` runs writing findings records.
Config contract (binding): `findings: { enabled: false, cadence: "<duration>", collection: "<name>" }` — enabling REQUIRES the named collection to already exist in config (explicit operator setup; the daemon never mutates config or writes outside a configured source path; misconfig → clear startup error). Record identity deterministic: id = hash(check-kind + target-uri + finding-content) → repeated runs upsert, no duplicate corpus; bounded retention documented. Observability contract: last-run state persisted (success | failed | skipped_lease | overdue, with timestamps and finding counts) and exposed via gno daemon --status (and doctor), so a starved or failing scheduler is distinguishable from a clean one without debug logs. Silent when clean; skips (recorded as skipped_lease) when a writer holds the lease.

**Touches:** src/serve/resident-runtime.ts (task loop), src/config/types.ts (findings block), findings record writer module (new), daemon status surface, docs (daemon + CONFIGURATION.md), tests

## Acceptance
- [ ] Config block validates; enabled-without-collection fails startup with a clear message; daemon never writes outside the configured collection path
- [ ] Seeded broken link produces a findings record on cadence; second run does not duplicate it (identity test); fix removes it or marks resolved per documented semantics
- [ ] Clean run writes nothing and logs nothing beyond debug; lease-held run skips
- [ ] Docs: daemon + CONFIGURATION.md; capsule-reverification explicitly documented as out of this pass

- [ ] gno daemon --status shows last findings-run state/timestamps; a forced failure and a lease-skip are both visible there (live test)

## Done summary
Serial retry of fn-132.4 after the CHANGELOG.md join collision with task .3: cherry-picked the original implementation commit 275f903f onto the joined target (86380b79, tasks .1 and .3 integrated) as one commit, keeping both the `gno changes --follow` bullet (.3) and the findings-pass bullet as separate `### Added` entries under `[Unreleased]`. No other file conflicted; no `.flow/` paths in the commit. Feature content is unchanged from the prior handover (`/home/gordon/work/gno-ws/handover/fn-132-4-summary.md`): opt-in `findings: { enabled, cadence, collection }` config with fail-closed daemon startup, lease-aware read-only audit pass writing deterministic `finding-<id>.md` records with resolve/reopen/retention semantics, persisted last-run state on `gno daemon --status` (line + JSON `findings`) and a `gno doctor` `Findings pass` check, DAEMON.md/CONFIGURATION.md/CLI.md docs, process-status schema gaining an optional `findings` property; saved Capsule reverification documented as out of scope.

Re-verified on the joined tree: `bun run lint` clean (one pre-existing warning outside this diff), focused findings + schema suites 363 pass, full `bun test` 4700 pass / 0 fail with a green receipt. Open follow-up unchanged: mirror the `docs/CLI.md` daemon findings bullet and the `--status --json` `findings` field into `spec/cli.md` (owned by .3, forbidden here). Notes: NOTES_DIR fn-132-4-findings-pass.md (design + integration warnings, plus a serial-retry section).

stage: impl-review - skipped(policy: parallel-wave - conductor owns the review after integration; REVIEW_MODE=none)

stage: wave-join - failed(collision: .4 vs .3 on CHANGELOG.md) then serial retry integrated as 30b78041
stage: impl-review - skipped(policy: review backend none)
stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 30b78041c873b34a973a4b83dbb4eeb7a4267e35
- Tests: bun run lint (0 errors; 1 pre-existing warning in test/cli/query-text.test.ts, outside this diff), bun test test/core/findings-records.test.ts test/core/findings-run-state.test.ts test/serve/findings-pass.test.ts test/serve/resident-runtime-findings.test.ts test/cli/daemon-findings-status.test.ts test/cli/doctor-findings.test.ts test/spec/schemas (363 pass, 0 fail), bun test (4700 pass, 2 skip, 0 fail, 552 files, suite_rc=0; receipt .flow/tmp/green-receipts/d5e4898f-unittest.json), baseline: none (spec defines no Quick commands; joined base 86380b79 taken as-is), live verification: carried over from the original attempt 275f903f (isolated daemon, seeded broken link, lease skip, forced failure, status/doctor) - not re-run on the joined tree; code content identical apart from the CHANGELOG merge, integrated: bun test test/serve test/spec/schemas test/cli/changes-follow.test.ts test/cli/index-cmd.test.ts
- PRs: