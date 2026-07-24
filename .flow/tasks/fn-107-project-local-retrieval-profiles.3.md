---
satisfies: [R2, R4, R6]
---
# fn-107-project-local-retrieval-profiles.3 Apply project profiles idempotently without implicit deletion

## Description
Deliver apply project profiles idempotently without implicit deletion as one implementation-sized increment.

**Size:** M
**Files:** `src/core/project-profile-apply.ts`, `src/core/project-profile-apply-state.ts`, `src/core/project-profile-diff.ts`, `src/core/config-mutation.ts`, `src/config/saver.ts`, `src/cli/commands/profile-apply.ts`, `src/cli/program.ts`, `spec/cli.md`, `spec/output-schemas/project-profile-apply.schema.json`, `test/core/project-profile-apply.test.ts`, `test/cli/project-profile.test.ts`

### Approach
- Apply create/update-only desired state through existing guarded config mutations and locks; require explicit separate action for collection/index deletion.
- Reuse `buildProjectProfileDiff()` for the pre-apply diff, record created/reused/updated/skipped resources, and resume safely after interruption or concurrent apply.
<!-- Updated by plan-sync: fn-107-project-local-retrieval-profiles.2 used buildProjectProfileDiff() not a planned apply-local diff -->
- Keep database, models, caches, receipts, and locks in user runtime directories; optionally write only gitignore guidance, never runtime state.

### Investigation targets
**Required** (read before coding):
- `src/core/config-mutation.ts`
- `src/config/saver.ts`
- `src/core/file-lock.ts`
- `src/collection/add.ts`

**Optional** (reference as needed):
- `src/core/user-dirs.ts`
- `src/serve/config-sync.ts`

## Acceptance
- [ ] Apply is idempotent and creates/updates only explicitly declared resources after showing a deterministic diff.
- [ ] Removing profile entries never implicitly removes collections/indexes or data.
- [ ] Interrupt/concurrent/stale mapping fixtures recover cleanly and runtime artifacts remain outside the repo.


## Done summary
Implemented lock-safe, create/update-only project profile apply through the shared compiler/diff pipeline, with deterministic external receipts, first-run config creation, stale mapping preservation, and no implicit collection/index deletion. Added the `gno profile apply` CLI contract plus interruption, concurrency, idempotency, runtime-path, schema, and regression coverage.
## Evidence
- Commits: c226dfb64848d170ec68345005a0673069338684
- Tests: GATE_SKIPPED:unittest:green-receipt 013ef3ed - baseline reused from prior post-gate pass, bun run typecheck, bun run lint:check, bun test test/core/project-profile-apply.test.ts test/config/project-profile.test.ts test/cli/project-profile.test.ts test/config/saver.test.ts test/core/file-lock.test.ts, bun test test/spec/schemas, bun test test/config/project-profile* test/cli/project-profile*, bun test, bun run docs:verify, .flow/bin/flowctl validate --spec fn-107-project-local-retrieval-profiles --json
- PRs: