---
satisfies: [R2, R4, R6]
---
# fn-107-project-local-retrieval-profiles.3 Apply project profiles idempotently without implicit deletion

## Description
Deliver apply project profiles idempotently without implicit deletion as one implementation-sized increment.

**Size:** M
**Files:** `src/core/project-profile-apply.ts`, `src/core/config-mutation.ts`, `src/config/saver.ts`, `src/core/file-lock.ts`, `test/core/project-profile-apply.test.ts`

### Approach
- Apply create/update-only desired state through existing guarded config mutations and locks; require explicit separate action for collection/index deletion.
- Show a pre-apply diff, record created/reused/updated/skipped resources, and resume safely after interruption or concurrent apply.
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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
