---
satisfies: [R2, R3, R5, R6]
---
# fn-107-project-local-retrieval-profiles.2 Implement safe discovery check show and diff

## Description
Deliver implement safe discovery check show and diff as one implementation-sized increment.

**Size:** M
**Files:** `src/core/project-profile-discovery.ts`, `src/cli/commands/profile.ts`, `src/cli/program.ts`, `test/cli/project-profile.test.ts`

### Approach
- Discover nearest profile from cwd with explicit root override; define monorepo/worktree/nested-profile precedence and never merge profiles implicitly.
- Expose check/show/diff as read-only operations over desired versus current config with redacted machine-local paths and no filesystem probing from remote callers.
- Detect stale prior mappings and show repair/removal choices without applying them.

### Investigation targets
**Required** (read before coding):
- `src/config/paths.ts`
- `src/cli/program.ts`
- `src/core/validation.ts`

**Optional** (reference as needed):
- `src/core/indexed-reference.ts`
- `src/cli/commands/status.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/core/project-profile.ts`

## Acceptance
- [ ] Nearest/override/monorepo/worktree/nested/ambiguous discovery fixtures follow one documented precedence.
- [ ] Check/show/diff are deterministic, stdout-clean in JSON, and never mutate config/index state.
- [ ] Stale mappings and unsupported schema/model references have actionable redacted diagnostics.


## Done summary
Implemented safe local project-profile discovery plus deterministic, redacted `gno profile check|show|diff` contracts. Added stale-mapping remediation, offline preset diagnostics, setup advisory discovery, and cross-boundary regression coverage without config/index mutation.
## Evidence
- Commits: 4b39470
- Tests: GATE_SKIPPED:unittest:green-receipt c251730c - baseline reused from prior post-gate pass, bun run lint:check, bun test test/config/project-profile* test/cli/profile*, bun test test/config/project-profile.test.ts test/cli/project-profile.test.ts, bun run docs:verify, .flow/bin/flowctl validate --spec fn-107-project-local-retrieval-profiles --json, bun test
- PRs: