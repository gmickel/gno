---
satisfies: [R1, R6]
---
# fn-118-cloud-placeholder-safe-indexing.1 Physical macOS File Provider no-materialization smoke and scan baseline

## Description
Build and run the physical-macOS proof point for R1/R6. The task owns a reusable, non-production smoke harness and a tracked redacted research receipt; it must not alter ingestion behavior.

**Size:** M
**Files:** `scripts/macos-file-provider-smoke.ts`, optional focused helper/test beside the script, `research/file-provider/2026-08-16-macos-smoke.md`, raw redacted JSON evidence under `research/file-provider/evidence/`
**Touches:** [scripts/macos-file-provider-smoke.ts, test/scripts/macos-file-provider-smoke.test.ts, research/file-provider/**]

### Approach
- Follow Apple TN3150: inspect `SF_DATALESS`, establish the no-materialization I/O policy, handle guarded refusal such as `EDEADLK`, and separately test directory traversal and content access.
- Follow the repository benchmark pattern: deterministic corpus, two warmups, nine measured samples, structured JSON, median/p95/min/max/stddev/raw samples.
- Use only dedicated disposable provider fixtures; hash/redact fixture identifiers and retain no credentials or source bytes.
- Compare existing scan/discovery behavior with candidate availability checks on a controlled all-local corpus; separate discovery, metadata, guarded read/hash, conversion, and embedding lanes where applicable.
- Record Google Drive and iCloud independently. Test installed OneDrive if a safe dedicated fixture can be created; otherwise mark it BLOCKED/NOT AVAILABLE and make no support claim.

### Investigation targets
**Required** (read before implementation):
- `src/ingestion/walker.ts:227-317` — current full-scan discovery and metadata operations
- `src/ingestion/sync.ts:694-844` — sniff/full-read/hash/conversion sequence
- `src/serve/watch-snapshot-scan.ts:154-295` — watcher traversal to probe separately
- `src/serve/watch-snapshot-libc.ts:54-185` — Darwin FFI loading/error precedent
- `scripts/watcher-reconciliation-benchmark.ts:21-160` — benchmark protocol and JSON receipt pattern

**Optional** (reference as needed):
- `src/ingestion/sync.ts:1280-1407` — targeted path that bypasses the walker
- `src/ingestion/sync.ts:1845-2115` — reconciliation behavior when paths are unseen

### Key context
- Availability-state observation itself can materialize content; every observer used as proof must be characterized.
- R1's product outcome is a cloud-placeholder skip even if the native guarded operation exposes a refusal errno.
- The Mac under test is macOS 27.0 beta build 26A5388g on Apple M4 Max; beta status is an explicit evidence caveat.

### Acceptance
- [ ] Harness has deterministic `--help`/dry validation and refuses non-Darwin or unsafe roots without mutation.
- [ ] Study matrix covers local, pinned/offline, cached-unpinned, cloud-only, nested dataless directory, partial-content if reproducible, and a classification-to-read race for each safely available provider.
- [ ] Before/after state evidence proves whether each metadata/traversal/guarded-read probe materialized content; rows are PASS/FAIL/BLOCKED/NOT AVAILABLE with no provider inference.
- [ ] Performance receipt contains environment, provider/version, corpus shape, run order, at least 2 warmups + 9 samples, raw values, median/p95/min/max/stddev, and separated phases; contaminated samples are identified.
- [ ] Tracked report gives a provider-neutral feasibility verdict, explicit performance answer, unsafe/unknown cases, raw evidence paths/digests, and no credentials, existing user content, or unredacted sensitive paths.
- [ ] Focused checks, `bun run lint:check`, and the applicable repository gate pass.

## Acceptance
- [ ] R1 physical provider/state matrix and no-materialization evidence complete or explicitly blocked
- [ ] R6 pre-implementation scan/performance baseline complete
- [ ] No production ingestion behavior changed
- [ ] Redacted reproducible receipt committed

## Done summary
Built a reusable, non-production Darwin File Provider smoke/benchmark harness with strict provider-root and fixture containment, fail-closed no-materialization policy handling, state-race support, deterministic 2+9 timing lanes, and focused tests. Tracked redacted physical evidence independently proves Google Drive and iCloud cloud-only refusal without hydration, leaves OneDrive unclaimed, records blocked/unavailable states, and establishes a 5,000-file candidate overhead of 15.2323%—a no-go for the naive extra-per-file check before task .2; all dedicated fixtures were moved to Trash.

Baseline: `bun run lint:check` green; `bun test` green (4216 pass, 2 skip); smoke help absent before implementation as expected task gap. Verify: focused harness tests 36 pass; `bun run lint:check` green; `bun test` 4252 pass, 2 skip, 0 fail; smoke help exit 0. No production ingestion behavior changed.

stage: impl-review - skipped(config: REVIEW_MODE=none)
stage: plan-sync - ran (model: gpt-5.6-terra)
## Evidence
- Commits: b22722a034793c8154b5ec3bb46c75a3e78d3cff
- Tests: bun test test/scripts/macos-file-provider-smoke.test.ts, bun scripts/macos-file-provider-smoke.ts benchmark-local --corpus-files 5000, bun run lint:check, bun test, bun scripts/macos-file-provider-smoke.ts --help
- PRs:
