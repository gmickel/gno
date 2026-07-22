---
satisfies: [R1, R3, R4]
---
# fn-95-public-documentation-and-multilingual.1 Create the public-truth manifest and drift verifier

## Description
Deliver create the public-truth manifest and drift verifier as one implementation-sized increment.

**Size:** M
**Files:** `scripts/docs-verify.ts`, `scripts/public-truth.ts`, `test/scripts/docs-verify.test.ts`, `package.json`

### Approach
- Derive current package/version/platform/model facts from canonical machine-readable sources and committed dated benchmark artifacts.
- Add anchor-aware checks for current claims while exempting changelog/history contexts.
- Emit deterministic actionable mismatches with file and claim class; keep nuanced prose outside the manifest.

### Investigation targets
**Required** (read before coding):
- `scripts/docs-verify.ts:1-460`
- `package.json`
- `src/app/constants.ts`
- `evals/fixtures/general-embedding-benchmark`

**Optional** (reference as needed):
- `CHANGELOG.md`
- `docs/comparisons`

## Acceptance
- [ ] Deliberately stale current-version/model/benchmark fixtures fail with actionable messages.
- [ ] Historical changelog/version references remain valid.
- [ ] The manifest links immutable dated evidence rather than temporary outputs or broad superlatives.


## Done summary
Added a machine-derived public-truth manifest and anchor-aware drift verifier for release, runtime, platform, model, and benchmark claims. Integrated deterministic diagnostics into docs verification with regression coverage for stale claims, immutable evidence, and archival-version exemptions.
## Evidence
- Commits: 5f8e3f5bafdbcc1f4ca11bf78de57fe86a07cc6b
- Tests: baseline: green, bun run lint:check, bun run docs:truth, bun run docs:verify, bun test test/scripts/docs-verify*, .flow/bin/flowctl validate --spec fn-95-public-documentation-and-multilingual --json
- PRs: