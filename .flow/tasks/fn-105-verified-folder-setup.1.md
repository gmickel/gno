---
satisfies: [R1, R2, R4, R5]
---
# fn-105-verified-folder-setup.1 Build the resumable setup orchestrator and receipt

## Description
Deliver build the resumable setup orchestrator and receipt as one implementation-sized increment.

**Size:** M
**Files:** `src/core/folder-setup.ts`, `src/core/setup-receipt.ts`, `src/core/config-mutation.ts`, `spec/output-schemas/setup-receipt.schema.json`, `test/core/folder-setup.test.ts`

### Approach
- Compose preflight, config/collection create-or-reuse, lexical sync, fn-94 proof, semantic handoff, connector check, and final status without duplicating their internals.
- Persist an idempotency/resume receipt before each side effect and settle it after commit, including generated paths, fingerprints, stage tokens, pending jobs, and rollback guidance.
- Define exit semantics: lexical proof required for success; semantic/optional connector may be pending only with explicit next action.

### Investigation targets
**Required** (read before coding):
- `src/cli/commands/init.ts`
- `src/collection/add.ts`
- `src/ingestion/sync.ts`
- `src/core/config-mutation.ts`

**Optional** (reference as needed):
- `src/core/file-lock.ts`
- `src/serve/background-runtime.ts:198-260`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/core/activation-verifier.ts`

## Acceptance
- [ ] Safe folder fixture creates/reuses a collection, indexes it, and returns a real scoped BM25 proof.
- [ ] Interrupted stages resume without duplicate collections, jobs, downloads, or corrupted config/index state.
- [ ] Receipt schema is canonical, fingerprinted, and truthful about completed/pending/failed stages.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
