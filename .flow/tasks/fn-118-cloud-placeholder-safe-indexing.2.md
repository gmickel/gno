---
satisfies: [R2, R3]
---
# fn-118-cloud-placeholder-safe-indexing.2 Add macOS source-availability policy and guarded read boundary

## Description
Implement the platform-neutral policy contract and Darwin guard bounded by task 1 physical evidence (R2/R3). Keep default `any` behavior unchanged.

Tasks 1 and 5 proved the provider-neutral guarded-read mechanism for dedicated Google Drive, iCloud Drive, and OneDrive cloud-only fixtures. OneDrive cloud-placeholder support is proven only for the tested OS/provider configuration and both installed immediate SharePoint library roots; unavailable or irreproducible states remain unsupported/unknown and fail closed. Do **not** add a naive extra availability check for every discovered file: it measured +15.2323% on the representative 5,000-file all-local corpus and fails the proposed <=10% R6 budget. Reusing existing traversal metadata flags and rechecking only content actually consumed or changed is an unmeasured optimization hypothesis, not a pass; preserve the content-boundary guard and require task 4 measurement before making a performance claim.

<!-- Updated by plan-sync: fn-118-cloud-placeholder-safe-indexing.1 measured naive per-file availability checks at +15.2323%, not the planned acceptable local-mode approach -->
<!-- Updated by plan-sync: fn-118-cloud-placeholder-safe-indexing.5 proved guarded OneDrive cloud-only refusal in both installed immediate library roots, not the planned unclaimed state -->

**Size:** M
**Files:** source-availability port/types and Darwin adapter, collection config parsing, focused unit/contract tests
**Touches:** [src/ingestion/source-availability/**, src/config/**, test/ingestion/source-availability/**, spec/output-schemas/**]

### Approach
- Extend the existing ports-without-DI pattern with one source-availability classifier/guard.
- Instantiate the Darwin adapter at command boundaries; unsupported/unknown local mode fails closed.
- Recheck immediately before source bytes are consumed; translate native refusal into the cloud-placeholder skip taxonomy.
- Do not introduce a second availability syscall per discovered file. Any reuse of traversal metadata flags is a hypothesis that must retain the guarded recheck at the consumed-content boundary and be physically benchmarked in task 4.

### Investigation targets
**Required** (read before implementation):
- `src/ingestion/types.ts:20-68` — ingestion port/result types
- `src/serve/watch-snapshot-libc.ts:54-185` — FFI loading/error pattern
- `src/ingestion/sync.ts:694-844` — guarded byte-read seam
- `spec/cli.md` — configuration and structured-output contract

**Optional** (reference as needed):
- `test/ingestion/sync-max-bytes.test.ts:51-103` — rejection and converter-spy test pattern
## Acceptance
- [ ] `any` remains the default with unchanged behavior.
- [ ] `local` establishes the proven macOS no-materialization policy for Google Drive, iCloud Drive, and OneDrive cloud-only fixtures in both tested immediate SharePoint library roots; OneDrive support remains limited to the tested configuration, and unknown states fail closed.
- [ ] Guarded content access converts unavailable/race outcomes into a distinct skip; unsupported/unknown safety fails closed.
- [ ] The implementation does not add the measured-failing naive extra availability check for every discovered file; any traversal-metadata reuse optimization remains unproven until task 4 physical measurement.
- [ ] Unit and contract tests cover policy setup failure, unknown flags, permissions, eviction race, partial content, and unsupported platforms.

- [ ] R2 policy/config contract implemented
- [ ] R3 guarded read boundary implemented
- [ ] Default mode unchanged and focused tests green
## Done summary
Implemented opt-in `sourceAvailability: local` with a platform-neutral contract, evidenced macOS File Provider path support, and a Darwin no-materialization read boundary that feeds sniffing, hashing, conversion, and record import without reopening source content. Default `any` preserves the legacy sniff/read and record-stream behavior; unsupported or unknown safety fails closed, while EDEADLK and partial reads become distinct cloud skips.

Focused coverage verifies malformed/default config, policy setup failure, unsupported platforms and storage, unknown flags/safety, permissions, symlinks, eviction races, partial content, record adapters, and unchanged `any` behavior. Baseline and verify gates were green.

GATE_SKIPPED:unittest:green-receipt a98feec1 - baseline reused from prior post-gate pass
GATE_SKIPPED:smoke:green-receipt a98feec1 - baseline reused from prior post-gate pass

stage: impl-review - skipped(config: REVIEW_MODE=none)
stage: plan-sync - ran [2026-08-16T12:15:49Z..2026-08-16T12:16:31Z] (model: gpt-5.6-terra)
## Evidence
- Commits: e84a2e849dc7ccbc66f970648c8bf226ff1c79d7
- Tests: GATE_SKIPPED:unittest:green-receipt a98feec1 - baseline reused from prior post-gate pass, GATE_SKIPPED:smoke:green-receipt a98feec1 - baseline reused from prior post-gate pass, bun test test/ingestion/source-availability test/ingestion/sync-max-bytes.test.ts test/ingestion/export-adapters-e2e.test.ts (53 pass, 0 fail), bun run lint:check, bun test (4306 pass, 2 skip, 0 fail), bun scripts/macos-file-provider-smoke.ts --help
- PRs:
