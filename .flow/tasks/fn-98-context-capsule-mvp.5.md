---
satisfies: [R1, R3, R4]
---
# fn-98-context-capsule-mvp.5 Expose Capsule build and verify through CLI and SDK

## Description
Deliver expose capsule build and verify through cli and sdk as one implementation-sized increment.

**Size:** M
**Files:** `src/cli/program.ts`, `src/cli/commands/context-build.ts`, `src/cli/commands/context-verify.ts`, `src/sdk/client.ts`, `src/sdk/types.ts`, `test/cli/context-capsule.test.ts`

### Approach
- Add `gno context build` and `gno context verify` over the shared compiler/verifier with deterministic JSON and readable Markdown.
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


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
