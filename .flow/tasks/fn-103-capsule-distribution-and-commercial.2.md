---
satisfies: [R1, R2, R6, R7]
---
# fn-103-capsule-distribution-and-commercial.2 Serve llms manifests Markdown and evidence safely on gno.sh

## Description
Deliver serve llms manifests markdown and evidence safely on gno.sh as one implementation-sized increment.

**Size:** M
**Files:** `/Users/gordon/work/gno.sh/src/lib/publish-artifact.ts`, `/Users/gordon/work/gno.sh/src/lib/publish-read-service.ts`, `/Users/gordon/work/gno.sh/src/routes/publish`, `/Users/gordon/work/gno.sh/test/publish`

### Approach
- Render deterministic per-space `llms.txt`, manifest JSON, no-JS Markdown documents, and exact evidence links from the imported public projection.
- Use revision/hash validators, visibility-aware robots/cache headers, and atomic revision activation with rollback/cache purge.
- Reject path guessing, source maps, unknown capabilities, and any secret/invite artifact from public reader endpoints.

### Investigation targets
**Required** (read before coding):
- `/Users/gordon/work/gno.sh/src/lib/publish-artifact.ts`
- `/Users/gordon/work/gno.sh/src/lib/publish-domain.ts`
- `/Users/gordon/work/gno.sh/src/lib/publish-read-service.ts`

**Optional** (reference as needed):
- `/Users/gordon/work/gno.sh/src/lib/publish-build.ts`
- `/Users/gordon/work/gno.sh/docs/handoffs/gno-publish-artifact-contract.md`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `/Users/gordon/work/gno.sh/src/lib/publish-access.ts`

## Acceptance
- [ ] A public fixture serves valid llms.txt, manifest, Markdown, and exact evidence URLs without JavaScript.
- [ ] Visibility/cache/path-guessing/source-map regressions cannot expose non-public material.
- [ ] Revision rollback restores the prior projection and purges validators/caches deterministically.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
