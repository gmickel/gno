---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# gno-27-fast-reliable-watcher-reconciliation.3 Prove cross-platform watcher correctness and performance

## Description
Add real-filesystem, resident-runtime, CI-matrix, performance, and live-service evidence for the complete watcher contract (R1-R7). This task proves the implementation rather than introducing another watcher path.

**Size:** M
**Files:** `test/serve/watch-service-filesystem.test.ts`, `test/serve/resident-runtime.test.ts`, `scripts/watcher-reconciliation-benchmark.ts`, `scripts/watcher-reconciliation-smoke.ts`, `package.json`, `.github/workflows/ci.yml`
**Touches:** [test/serve/watch-service-filesystem.test.ts, test/serve/resident-runtime.test.ts, scripts/watcher-reconciliation-benchmark.ts, scripts/watcher-reconciliation-smoke.ts, package.json, .github/workflows/ci.yml]

### Approach
- Build real-temp-directory tests for plain-temp and dot-temp atomic replacement, same-size/restored-mtime exact edits, multi-depth delete, post-watch directory creation, symlink replacement/no-follow, root loss/recovery, and untouched siblings.
- Add a deterministic candidate-discovery benchmark with one changed file among 5,000 eligible siblings, warm-up, repeated samples, p95 calculation, selected-path assertions, and separate fast-path/fallback reporting.
- Exercise Bun 1.3.11 and current Bun on macOS, Linux, and Windows in the supported CI matrix where runners permit; keep platform-event assertions capability-aware without weakening end-state correctness.
- Add a bounded live `gno serve` smoke using a real SQLite store and deterministic local lexical search: atomic save and nested deletion become visible without `gno update`, an untouched sibling remains searchable, and an unrelated API request stays responsive. Verify daemon parity through the shared `ResidentRuntime` construction/contract rather than duplicating the full smoke.
- Capture exact commands, p95 output, OS/Bun versions, and any platform-specific limitation as task evidence.

### Investigation targets
**Required** (read before coding):
- `test/serve/watch-service.test.ts:1-46` — watcher test factories and cleanup conventions
- `test/serve/resident-runtime.test.ts:188-249` — shared generation/settlement integration
- `test/ingestion/sync-incremental.test.ts:71-164` — no-walk and event-loop responsiveness proof
- `src/serve/resident-runtime.ts:264-305` — shared watcher construction
- `src/cli/commands/daemon.ts:141-267` — daemon ownership and shutdown contract

**Optional** (reference as needed):
- `.github/workflows/ci.yml` — current OS/Bun matrix and cache setup
- `scripts/package-smoke-resident-support.ts` — resident smoke orchestration pattern

### Key context
- R4 measures candidate discovery, including filesystem/stat/store work used by that stage, not ingestion, embedding, or graph projection.
- Network/removable/coarse-timestamp filesystems are not claimed unless the bounded fallback is active and proven.

### Acceptance
- [ ] Real-filesystem tests prove R1-R3 on each supported platform/Bun lane, with explicit evidence for skipped platform capabilities.
- [ ] Benchmark asserts one selected candidate and p95 <=250 ms on macOS/Linux and <=500 ms on Windows under the documented protocol.
- [ ] Failure/race/overflow/churn suites prove R5-R6 without unbounded waits or memory growth.
- [ ] Live serve smoke proves atomic-save searchability, nested deletion, untouched-sibling preservation, and API responsiveness without manual update; daemon uses the same watcher contract.
- [ ] Focused suites, `bun run lint:check`, and full `bun test` pass.

## Acceptance
- [ ] TBD

## Done summary
Added cross-platform correctness and performance proof for watcher reconciliation: deterministic real-filesystem service tests, shared serve/daemon ResidentRuntime contract coverage, a 5,000-file candidate-discovery p95 benchmark with separate fallback reporting, and a bounded live `gno serve` smoke using real SQLite and lexical HTTP search. Added focused package commands and six CI lanes spanning macOS, Linux, and Windows on Bun 1.3.11 plus latest. Host-native implementation review concluded SHIP.
## Evidence
- Commits: 2af86822
- Tests: Bun 1.3.11: bun test test/serve/watch-service-filesystem.test.ts test/serve/resident-runtime.test.ts (10 pass, 0 fail), Bun 1.3.11: bun scripts/watcher-reconciliation-benchmark.ts (5000 files, one selected candidate, p95 58.61ms <= 250ms macOS threshold; fallback 64.04ms reported separately), Bun 1.3.11: bun scripts/watcher-reconciliation-smoke.ts (atomic visible, nested deletion inactive, sibling searchable, unrelated status 0.16ms, no manual update), Bun 1.3.11: bun test (4215 pass, 2 expected skips, 0 fail across 506 files), bun run lint:check (0 warnings, 0 errors; formatting clean), host-native implementation review SHIP (reservation 2fab288e530d41b48d36995d68d1a130)
- PRs: