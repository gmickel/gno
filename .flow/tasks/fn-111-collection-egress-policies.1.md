---
satisfies: [R1, R2, R7, R8]
---
# fn-111-collection-egress-policies.1 Define egress policy schema evaluator and fail-closed migration

## Description
Deliver define egress policy schema evaluator and fail-closed migration as one implementation-sized increment.

**Size:** M
**Files:** `src/core/egress-policy.ts`, `src/config/types.ts`, `src/store/migrations/015-collection-egress.ts`, `src/store/types.ts`, `test/egress/policy.test.ts`

### Approach
- Add effective `local_only|lan|remote` to collection config/store with new and legacy collections defaulting local_only until explicit choice.
- Define one evaluator input for collections/action/destination/caller/auth/content class and stable redacted allow/deny reason codes.
- Enumerate actions and derived classes now; unknown action/destination/policy fails closed, and auth can narrow but never override policy.

### Investigation targets
**Required** (read before coding):
- `src/config/types.ts:71-114`
- `src/store/types.ts:67-130`
- `src/store/migrations/index.ts`
- `src/core/errors.ts`

**Optional** (reference as needed):
- `src/core/config-mutation.ts`
- `spec/db/schema.sql`

### Key context
- Already-public remote artifacts cannot be made private by this migration; disclose irreversibility and block future transfers until policy is explicit.
- A local file export is local; marking/uploading/public publishing is a separate remote action.

## Acceptance
- [ ] Every collection has deterministic effective policy/source and unknowns fail closed with stable codes.
- [ ] Legacy/new migration preserves local retrieval while blocking unapproved new network actions.
- [ ] Evaluator unit tests cover every action/content class and prove authentication cannot relax policy.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
