---
satisfies: [R2, R3]
---
# fn-118-cloud-placeholder-safe-indexing.2 Add macOS source-availability policy and guarded read boundary

## Description
Implement the platform-neutral policy contract and Darwin guard proven by task 1 (R2/R3). Keep default `any` behavior unchanged.

**Size:** M
**Files:** source-availability port/types and Darwin adapter, collection config parsing, focused unit/contract tests
**Touches:** [src/ingestion/source-availability/**, src/config/**, test/ingestion/source-availability/**, spec/output-schemas/**]

### Approach
- Extend the existing ports-without-DI pattern with one source-availability classifier/guard.
- Instantiate the Darwin adapter at command boundaries; unsupported/unknown local mode fails closed.
- Recheck immediately before source bytes are consumed; translate native refusal into the cloud-placeholder skip taxonomy.

### Investigation targets
**Required** (read before implementation):
- `src/ingestion/types.ts:20-68` — ingestion port/result types
- `src/serve/watch-snapshot-libc.ts:54-185` — FFI loading/error pattern
- `src/ingestion/sync.ts:694-844` — guarded byte-read seam
- `spec/cli.md` — configuration and structured-output contract

**Optional** (reference as needed):
- `test/ingestion/sync-max-bytes.test.ts:51-103` — rejection and converter-spy test pattern

### Acceptance
- [ ] `any` remains the default with unchanged behavior.
- [ ] `local` establishes the proven macOS no-materialization policy and classifies local/dataless/unknown.
- [ ] Guarded content access converts unavailable/race outcomes into a distinct skip; unsupported/unknown safety fails closed.
- [ ] Unit and contract tests cover policy setup failure, unknown flags, permissions, eviction race, partial content, and unsupported platforms.

## Acceptance
- [ ] R2 policy/config contract implemented
- [ ] R3 guarded read boundary implemented
- [ ] Default mode unchanged and focused tests green

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
