---
satisfies: [R1, R2, R5, R6]
---
# fn-95-public-documentation-and-multilingual.3 Propagate and verify truthful public documentation

## Description
Deliver propagate and verify truthful public documentation as one implementation-sized increment.

**Size:** M
**Files:** `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`, `/Users/gordon/work/gno.sh/src/lib/site-content.ts`, `/Users/gordon/work/gno.sh/src/lib/gno-comparisons.tsx`, `scripts/docs-verify.ts`

### Approach
- Apply the same evidence-backed claims to canonical hosted-site sources, pricing/FAQ/install/comparison surfaces, without treating the legacy website directory as production.
- Deploy gno.sh only after both repos are committed and run live HTTP/service/revision checks.
- Define release blocking behavior: a failed production docs deployment prevents claiming public alignment but does not falsify local code status.

### Investigation targets
**Required** (read before coding):
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`
- `/Users/gordon/work/gno.sh/src/lib/site-content.ts`
- `/Users/gordon/work/gno.sh/src/lib/gno-comparisons.tsx`
- `/Users/gordon/work/gno.sh/scripts/deploy-prod.sh`

**Optional** (reference as needed):
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`
- `/Users/gordon/work/gno.sh/src/routes/pricing.tsx`

## Acceptance
- [ ] Hosted docs and product/price/comparison claims match canonical evidence and explicitly mark deferred capabilities.
- [ ] Deployment proves HTTPS, active service, and remote revision equals gno.sh origin/main.
- [ ] Docs verifier and a documented surface-ownership map prevent the legacy website from becoming a competing truth source.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
