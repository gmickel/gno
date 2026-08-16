---
satisfies: [R1]
---
# fn-118-cloud-placeholder-safe-indexing.5 Complete macOS OneDrive evidence across both installed libraries

## Description
Complete the physical macOS proof for the two installed OneDrive SharePoint library roots before production implementation begins. The earlier parent-container fixture was excluded from sync and did not test either library.

Use only uniquely named disposable `GNO-fn118-smoke-*` children inside each validated library. Do not read existing user-file contents, alter existing availability state, or change production GNO behavior. Extend the smoke harness only as needed to safely recognize immediate OneDrive library roots beneath the installed File Provider domain, preserving fail-closed root and fixture validation.

**Size:** S
**Files:** macOS smoke harness/tests and internal research evidence only
**Touches:** [scripts/macos-file-provider-smoke*.ts, test/scripts/macos-file-provider-smoke.test.ts, research/file-provider/**]

### Approach
- Enumerate and validate both installed OneDrive library roots independently; redact user/library names from committed evidence.
- Establish local baseline, then exercise cloud-only, pinned/offline, cached-unpinned, nested-directory, partial-content, and classification-to-read race rows wherever OneDrive safely exposes those states.
- Record every library/state row as PASS, FAIL, BLOCKED, or NOT AVAILABLE. Never infer one library from the other or OneDrive from Google/iCloud.
- Verify metadata/traversal/guarded-read probes do not change independently observed availability. A cloud-only guarded read must refuse with zero bytes.
- Clean only the dedicated fixtures, verify their active paths are absent, and retain no credentials or source bytes.
- Do not modify runtime ingestion or use the rejected naive per-discovered-file availability check.

### Investigation targets
- `scripts/macos-file-provider-smoke.ts`
- `scripts/macos-file-provider-smoke-lib.ts`
- `scripts/macos-file-provider-smoke-ops.ts`
- `scripts/macos-file-provider-smoke-benchmark.ts`
- `test/scripts/macos-file-provider-smoke.test.ts`
- `research/file-provider/2026-08-16-macos-smoke.md`

## Acceptance
- [ ] Both installed OneDrive SharePoint library roots are validated and tested independently with dedicated fixtures; committed artifacts redact root and library names.
- [ ] Each reproducible state records before/after `SF_DATALESS`, probe outcome, bytes read, and PASS/FAIL/BLOCKED/NOT AVAILABLE without cross-library inference.
- [ ] Cloud-only guarded reads, if reproducible, refuse materialization with zero bytes and leave availability unchanged; unavailable states remain explicitly unclaimed.
- [ ] Harness root validation accepts only installed immediate OneDrive library roots and rejects arbitrary descendants, siblings, traversal, and symlink escapes.
- [ ] Existing Google Drive/iCloud safety behavior and tests remain green; no production GNO ingestion behavior changes.
- [ ] Dedicated fixtures are removed from active OneDrive roots and cleanup is independently verified.
- [ ] R1 OneDrive evidence is sufficient to decide whether macOS implementation may claim OneDrive support or must fail closed.


## Done summary
Validated both installed immediate OneDrive SharePoint library roots independently with dedicated disposable fixtures and extended the non-production smoke harness to accept only those immediate roots while rejecting the aggregation root, descendants, traversal, fixture-shaped roots, and symlink escapes. Both libraries passed local, cached-unpinned, and cloud-only probes; cloud-only guarded reads preserved SF_DATALESS and refused with EDEADLK/zero bytes. The classification-to-read race passed in one library and remained NOT AVAILABLE after bounded attempts in the other; nested and partial states remain NOT AVAILABLE, pinned/offline remains BLOCKED. Redacted evidence records each independent verdict, and both fixtures were moved to Trash with active paths verified absent. No production GNO ingestion behavior changed.

Baseline: `bun run lint:check` green; `GATE_SKIPPED:unittest:green-receipt b22722a0 - baseline reused from prior post-gate pass`; `GATE_SKIPPED:smoke:green-receipt b22722a0 - baseline reused from prior post-gate pass`. Verify: focused smoke tests 46 pass; lint green; full `bun test` 4262 pass, 2 skip, 0 fail; smoke help exit 0.

stage: impl-review - skipped(config: REVIEW_MODE=none)
stage: plan-sync - ran [2026-08-16T11:52:20Z..2026-08-16T11:53:42Z] (model: gpt-5.6-terra)
## Evidence
- Commits: a98feec143a644afb5ec481f27f2f17a87e3abb7
- Tests: GATE_SKIPPED:unittest:green-receipt b22722a0 - baseline reused from prior post-gate pass, GATE_SKIPPED:smoke:green-receipt b22722a0 - baseline reused from prior post-gate pass, bun test test/scripts/macos-file-provider-smoke.test.ts (46 pass, 0 fail), bun run lint:check, bun test (4262 pass, 2 skip, 0 fail), bun scripts/macos-file-provider-smoke.ts --help, physical OneDrive matrix: both immediate libraries local/cached-unpinned/cloud-only; nested/pinned-offline/partial/race independently classified; EDEADLK zero-byte refusal verified where cloud-only reproduced, cleanup: both exact fixture active paths absent; active run fixture count 0
- PRs:
