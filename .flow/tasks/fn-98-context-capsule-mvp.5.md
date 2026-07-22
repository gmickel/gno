---
satisfies: [R1, R3, R4]
---
# fn-98-context-capsule-mvp.5 Expose Capsule build and verify through CLI and SDK

## Description
Deliver expose capsule build and verify through cli and sdk as one implementation-sized increment.

**Size:** M
**Files:** `src/cli/program.ts`, `src/cli/commands/context-build.ts`, `src/cli/commands/context-verify.ts`, `src/sdk/client.ts`, `src/sdk/types.ts`, `test/cli/context-capsule.test.ts`

### Approach
- Add `gno context build` and `gno context verify` over `planContextEvidence` and the shared verifier with deterministic JSON and readable Markdown; wire `searchHybrid`, task 3's strict snapshot/materialization loader, and the complete canonical projector through `ContextCompilerDeps` rather than duplicating planner behavior.
- Support explicit output files without implicit persistence; keep progress on stderr and canonical payload on stdout/file.
- Add SDK methods using the same option/result types and error taxonomy.

### Investigation targets
**Required** (read before coding):
- `src/cli/program.ts:216-900`
- `src/cli/commands/query.ts`
- `src/sdk/client.ts`
- `src/sdk/types.ts`

**Optional** (reference as needed):
- `src/cli/format/search-results.ts`
- `test/cli/bench.test.ts`

## Acceptance
- [ ] CLI JSON, CLI Markdown, and SDK emit equivalent canonical Capsule content.
- [ ] Budget/filter/index/goal options validate consistently and stdout remains clean.
- [ ] Verify accepts schema-valid files and returns per-evidence classifications without mutation.
- [ ] JSON/Markdown/SDK preserve canonical URI parity, exact final `usedBytes`, the estimator-specific `usedTokens` contract, safety margins, evidence bindings, and omission `reasonCounts`.
- [ ] CLI and SDK use the same `planContextEvidence` dependency wiring and do not expose or serialize symbol-keyed `SEARCH_RESULT_PLANNER_METADATA`.
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.1 used the frozen canonical Capsule accounting and evidence contract -->
<!-- Updated by plan-sync: fn-98-context-capsule-mvp.2 used injected retrieval, materialization, and canonical projection seams -->


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
