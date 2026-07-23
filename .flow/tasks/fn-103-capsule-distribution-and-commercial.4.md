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
Delivered the privacy-safe design-partner operating playbook and truthful production launch.

- Added a five-partner concierge workflow with explicit consent, opt-out, bounded retention, content-free events, pseudonymous cohort aggregation, and ordered approval seals.
- Reconciled pricing, product, privacy, publishing, and hosted-site copy so free local GNO, shipped public projection, concierge validation, and deferred private collaboration remain distinct.
- Merged GNO PR #144 and companion gno.sh PR #14 after core CI and focused in-harness review; intentionally did not wait for macOS/Windows packaging artifacts per user direction.
- Deployed gno.sh commit `75fbdbc9d3806ff3d162c67875f8be21d64e4aeb` and verified service state, exact revision, HTTPS pages, cache/ETag/CSP behavior, canonical agent manifest, Markdown bytes/lines/hash/locator integrity, source-map parity, conditional requests, and restricted-route non-disclosure.
- Created only fixed synthetic non-customer production fixtures under `gno-ops-agent-fixture`.
- Verified retained-projection rollback to revision `f59e71a3eaf394556b8eacd0837e2eb05c160e44860dbf2b56d1d32f2716c033`, restored revision `25d16342f427a9b38253f25fa633b55e3c47f9c4357ef57746efdd0985bea140`, and passed the full verifier after each state.
- Verified deployment rollback to `330e1cba0e4ae66fece7da0155f996b4b047137f` with the service active and `/`, `/pricing`, and `/privacy` returning 200; redeployed current and passed the full production verifier again.

No customer documents, query text, raw customer URLs, or evidence spans were captured.
## Evidence
- Commits: 771f418, 75fbdbc9d3806ff3d162c67875f8be21d64e4aeb
- Tests: gno.sh: bun test (107 pass, 7 database integration skips), gno.sh: bun run typecheck, gno.sh: bun run check, gno.sh: bun run build (67 prerendered routes), gno: bun run lint:check, gno: bun test test/docs-verify.test.ts (13 pass, 2 model-cache skips), production: verify:prod-launch on current deployment, production: verify:prod-launch after retained projection rollback, production: verify:prod-launch after projection restore, production: deployment rollback smoke at 330e1cba0e4ae66fece7da0155f996b4b047137f, production: verify:prod-launch after redeploying 75fbdbc9d3806ff3d162c67875f8be21d64e4aeb
- PRs: https://github.com/gmickel/gno/pull/144, https://github.com/gmickel/gno.sh/pull/14
