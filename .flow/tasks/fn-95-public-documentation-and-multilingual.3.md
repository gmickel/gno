---
satisfies: [R1, R2, R5, R6]
---
# fn-95-public-documentation-and-multilingual.3 Propagate and verify truthful public documentation

## Description
Deliver propagate and verify truthful public documentation as one implementation-sized increment.

**Size:** M
**Files:** `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`, `/Users/gordon/work/gno.sh/src/lib/site-content.ts`, `/Users/gordon/work/gno.sh/src/lib/gno-comparisons.tsx`, `scripts/public-truth.ts`, `scripts/docs-verify.ts`

### Approach
- Apply the same evidence-backed claims to canonical hosted-site sources, pricing/FAQ/install/comparison surfaces, without treating the legacy website directory as production.
- Deploy gno.sh only after both repos are committed and run live HTTP/service/revision checks.
- Define release blocking behavior: a failed production docs deployment prevents claiming public alignment but does not falsify local code status.
- Treat `PUBLIC_TRUTH` and its dated evidence artifacts as the canonical local source for exact current facts. The repository verifier scans anchored local surfaces only; compare gno.sh sources against that contract during this task and retain the production deployment checks as the hosted-site proof.
- Document the source-ownership boundary explicitly: `website/` is a locally verified legacy surface, while `/Users/gordon/work/gno.sh` is the canonical hosted-site source.

<!-- Updated by plan-sync: fn-95-public-documentation-and-multilingual.1 used verifyRepositoryPublicTruth for anchored local surfaces; it does not scan gno.sh -->

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
- [ ] `bun run docs:truth` and `bun run docs:verify` pass for local anchored surfaces; gno.sh claim alignment is independently checked against `PUBLIC_TRUTH` and its immutable evidence before deployment.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
