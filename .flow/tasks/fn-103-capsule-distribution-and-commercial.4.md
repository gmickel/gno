---
satisfies: [R4, R5, R6, R7]
---
# fn-103-capsule-distribution-and-commercial.4 Run privacy-safe design-partner validation and truthful launch

## Description
Deliver run privacy-safe design-partner validation and truthful launch as one implementation-sized increment.

**Size:** M
**Files:** `/Users/gordon/work/gno.sh/src/lib/site-content.ts`, `/Users/gordon/work/gno.sh/src/routes/pricing.tsx`, `/Users/gordon/work/gno.sh/src/routes/privacy.tsx`, `/Users/gordon/work/gno.sh/docs/prd`, `docs/PUBLISHING.md`

### Approach
- Define a five-partner concierge playbook, consent/opt-out/retention rules, and content-free funnel events for onboarding, first publish, share/invite, republish, and weekly retention.
- Aggregate small-cohort metrics conservatively and never capture document/query content, raw URLs, or evidence spans.
- Remove/mark deferred promises, deploy gno.sh, verify service/revision/cache/rollback, and keep private agent access explicitly blocked pending fn-111 plus dedicated auth.

### Investigation targets
**Required** (read before coding):
- `/Users/gordon/work/gno.sh/src/routes/pricing.tsx`
- `/Users/gordon/work/gno.sh/src/routes/privacy.tsx`
- `/Users/gordon/work/gno.sh/src/lib/site-content.ts`
- `/Users/gordon/work/gno.sh/scripts/deploy-prod.sh`

**Optional** (reference as needed):
- `/Users/gordon/work/gno.sh/src/routes/acceptable-use.tsx`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `docs/PUBLISHING.md`

### Key context
- This task creates a measurable operating playbook; it does not fabricate five completed trials if partners have not yet run them.

## Acceptance
- [ ] Concierge workflow can run five trials with explicit consent, opt-out, retention, and content-free events.
- [ ] Pricing/product/privacy copy clearly separates free local GNO, shipped public projection, concierge service, and deferred private collaboration API.
- [ ] Production deployment, HTTPS/service/revision, cache/security, analytics privacy, rollback, and private-route-absence checks pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
