---
satisfies: [R1, R2, R3]
---
# fn-201-test-and-ci-reliability-windows-update.1 Implement test and CI reliability fixes

## Description
TBD

## Acceptance
Every R-ID in the parent spec's Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
All three requirements are met. R1: the Windows `update` "hang" was a 9 to 11 s cold load of the PDF/Office parsers, triggered by the first record-adapter lookup of every update. The registry now loads them only when a matching file converts; a phase trace (`GNO_PHASE_TRACE=1`) stays as the diagnostic. R2: the scaling guards compare 4x sizes against an 8x bound. R3: one test's env restore wrote the string "undefined"; it is fixed, and a preload guard fails the class.

stage: impl-review - skipped(config: REVIEW_MODE=none)

R1 (Windows update hang):
- Instrumented: `src/core/phase-trace.ts` writes synchronous stderr lines per phase (lease, index open, journal mode, migrations, walk, each file, record-adapter selection, file processor). `test/cli/concurrency.test.ts` turns it on, so a hang report names each child's last phase.
- Reproduced on windows-latest with a temporary workflow on the spec branch (runs 36500063334, 36501141868, 36502390780, 36503593515; now removed). Cold runs spent 9.3 s and 11.2 s between `sync: file a.md` and `sync: record adapter selected`, with every other phase in milliseconds. One full-suite pass took 16.9 s, just under the 17 s watchdog.
- Fix: `src/converters/registry.ts` `lazyAdapter` replaces `loadAdapter`. markitdown-ts and officeparser route through light `match.ts` modules and import on first conversion. A load failure still fails only their file types with ADAPTER_FAILURE. Regression test: `test/converters/registry.test.ts` "default registry loading (fn-201)" (subprocess checks `require.cache`: routing a .md loads no parser, converting a .pdf does). The error case is in "unavailable adapter stand-in" (routing never calls the loader, a failed load reports its reason and is attempted once).
- The timeout, retries and skips were not changed.

Defect route (R1):
- prior fixes: open PRs #181/#182 (dependabot, unrelated); no open issue matched "windows update hang"; memory bug track had only the PowerShell ACL cold-start entry (not on the update/ls path, ruled out by reading its callers); no reverts on registry.ts.
- diagnosis: eliminated write lease / busy timeout (trace: lease acquired in about 10 ms, `ls` never takes it); eliminated WAL/journal/migrations (trace: under 5 ms each on Windows); eliminated per-file worker startup (trace: `processor: ready` 70 ms after awaiting); the concurrent `ls` was irrelevant (it finished in under 0.5 s every time). Confirmed a cold import of markitdown-ts (pdf.js plus its native canvas binding) inside `ConversionPipeline.selectRecordAdapter` -> `createDefaultRegistry`: 9.3 s and 11.2 s on windows-latest (run 36502390780), about 590 of 670 ms cold on Linux.
- introduced by: skipped: no known-good revision (the eager registry load dates from cb1af616 "feat: add portable file export adapters (#154)", 2026-07-25; the flake rate depends on runner speed, so a bisect cannot give a clean answer).
- base: 7b948865 cold Windows run 10.7 s / 12.5 s, full-suite 4.0 to 6.1 s and one at 16.9 s; regression test red at 7ce5b2ba (`afterRouting: true`) | head: f120ee83 cold Windows run 1.37 s / 1.43 s, full-suite 0.73 to 0.97 s, 0 hangs in 3 full suites and 20 loop runs; regression test green.
- live: no live surface (CLI child timing on the CI runner is the observation above).

R2 (fragile scaling test): `test/ingestion/strip.test.ts` compares 1,500 against 6,000 rows with bound `large <= 8 * small + 25`. It alternates the two sizes over 5 rounds and keeps each size's fastest pass. Head scales 4.5 to 5.2x; v2.8.3 scales 13 to 16x. Against v2.8.3 (temporary worktree) both cases fail on the bound (`x]` 5,262 ms large, `[[open` 1,103 ms large). On head: 25/25 green sequentially and 20/20 green with four parallel copies.

R3 (stray lock file): `test/sessions/automation.test.ts` afterEach assigned `process.env.GNO_*_DIR = env.x` unconditionally; with the variable unset, Bun stores the string "undefined" (seen after 4 of 53 tests). A later data-dir lookup from the repository cwd resolves to `./undefined/`. Fixed by deleting the variable when it was unset. Guard: `test/preload/env-guard.ts` (registered in bunfig.toml) fails any test that starts with an env var newly set to "undefined". Product code cannot build a lock path from a JS undefined (`resolveDirs` falls back via `??`; `dirname(undefined)` throws), so no product change. `.gitignore` is untouched.

Defect route (R3):
- prior fixes: 38a79a3b removed the committed `undefined/.mcp-write.lock` (symptom only); no open PR or issue.
- diagnosis: eliminated every other env restore in test/ (all guarded); a probe on acquireWriteLock/resolveDirs over a full run did not fire, so the exact write in fn-200 was not reproduced. Confirmed that the leaking restore stores "undefined" (instrumented afterEach: 4 of 53 tests) and that the value resolves to a relative data dir.
- introduced by: d7d7811a "Opt-in session hooks and scheduled ingestion (#248)" (added the test; read from history, not bisected).
- base: e35007dd guard fails automation.test.ts ("A previous test restored GNO_CONFIG_DIR, GNO_DATA_DIR, GNO_CACHE_DIR to the string \"undefined\"") | head: fcccae64 53 pass; full `bun test` leaves `git status` clean with no `undefined/`.
- live: no live surface.

Follow-ups (not built):
- Document `GNO_PHASE_TRACE` on ~/work/gno.sh (downstream docs).
- The Bun behaviour behind "undefined" appearing after only some of the restores was not explained; the guard catches it either way.
- The temporary workflow and loop script remain in this branch's history (removed in 9aba7576). A squash merge keeps them off main.

Gates: `bun run lint:check` (0 errors), `bun run docs:verify` (15 passed), `bun test` (6051 pass, 3 skip, 0 fail).

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: e35007dd86ac2f9abe687617d8a53af9dd2871b4, fcccae6435ba5a18f4c518ce953516c5c21676d7, cbf54d7d8def0e7850c6cc67512c04193ab68b7a, 2ffd42a3300460228db70ebe0fb71c271697ab71, 238623829b52564a6d2c58a65f31563aa99cd30f, d385ea32bcfb6f81f6d3ab8569d3aa3447587a32, 7b9488658b625bb85f3bf00b9a6493fe40aeacf1, 7ce5b2baedb4a410723de65e1afd48e1fa15b1d8, f120ee83f41d128fbeb3ca5c89fb2a710bcb29ee, 9aba7576b0c9f7c7ed750ff88ceee8ea163c8bc5
- Tests: bun run lint:check, bun test, bun run docs:verify, bun test test/ingestion/strip.test.ts -t 'stay linear' (25x sequential, 20x under 4-way contention)
- PRs: