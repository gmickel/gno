---
satisfies: [R1, R2, R4, R5]
---
# fn-94-retrieval-proven-setup-and-connector.3 Integrate activation into CLI REST and onboarding health

## Description
Deliver integrate activation into cli rest and onboarding health as one implementation-sized increment.

**Size:** M
**Files:** `src/cli/commands/doctor.ts`, `src/cli/commands/status.ts`, `src/serve/routes/api.ts`, `src/serve/status.ts`, `src/serve/public/components/BootstrapStatus.tsx`

### Approach
- Expose the shared receipt additively through doctor/status and Web health without duplicating probe logic.
- Show exact failed/pending stage, next command, and semantic background state; keep JSON stdout clean.
- Cache only by receipt fingerprint and coalesce concurrent checks without allowing stale green state.

### Investigation targets
**Required** (read before coding):
- `src/cli/commands/doctor.ts`
- `src/serve/routes/api.ts:732-780`
- `src/serve/status.ts`
- `src/serve/public/components/BootstrapStatus.tsx`

**Optional** (reference as needed):
- `src/serve/public/components/HealthCenter.tsx`
- `src/serve/status-model.ts`

## Acceptance
- [ ] CLI, REST, and Web render the same stage statuses and remediation from one contract.
- [ ] A failed lexical stage cannot appear green on any surface.
- [ ] Semantic pending does not block lexical usability and is visibly distinguished from failure.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
