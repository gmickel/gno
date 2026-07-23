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
Implemented the gno.sh public-agent publication projection end to end.

- Added strict host-side validation for the GNO public manifest, exact capability allowlist, note bytes, SHA-256 hashes, evidence identity, exact line ranges, public URIs, relative evidence locators, and canonical projection revision.
- Added no-JavaScript `llms.txt`, `manifest.json`, and exact Markdown document routes with GET/HEAD, strong content ETags, conditional 304 responses, public revalidation caching, indexing headers, and script-free CSP.
- Added uniform private 404/no-store/noindex behavior for restricted spaces, unknown documents, malformed or guessed paths, and source-map routes.
- Stored immutable agent projections with publish snapshots, switched active revisions transactionally, retained prior revisions, purged route caches after activation, and added database/fallback rollback.
- Added an operator rollback command and production runbook.
- Preserved the existing human reader and documented agent-readable public spaces in the hosted product/docs surfaces and the upstream artifact handoff.
- Added unit and real Postgres/MinIO integration coverage, including invalid activation preserving the current revision and rollback restoring the retained projection.

Hosted implementation commit: `47825d4` in `/Users/gordon/work/gno.sh`, pushed on `feat/capsule-distribution-commercial`.
## Evidence
- Commits: 47825d4
- Tests: gno.sh: bun run check, gno.sh: bun run typecheck, gno.sh: bun run test (25 files, 88 passed, 4 DB tests skipped by normal env), gno.sh: bun run test:integration (4 passed with Postgres and MinIO), gno.sh: bun run build (67 pages prerendered)
- PRs: