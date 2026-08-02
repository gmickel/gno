---
satisfies: [R7, R8]
---

# fn-71-bundled-image-attachments-in-publish-export.5 Prove cross-repo image publishing and reconcile release surfaces
## Description
Run the cross-repo release gate: producer-to-reader fixtures, public/secret/encrypted DOM proof, hostile and byte-boundary cases, independent rollout/rollback compatibility, documentation/skill reconciliation, and local/live QA evidence.

**Size:** M
**Files:** `test/publish/`, `spec/`, `docs/PUBLISHING.md`, `docs/CLI.md`, `docs/API.md`, `docs/SYNTAX.md`, `README.md`, `CHANGELOG.md`, `assets/skill/`, `/Users/gordon/work/gno.sh/docs/`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`, `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`

## Approach
- Pack/install the real GNO artifact used by gno.sh smoke tests; do not test only hand-authored JSON.
- Drive one raster image through public, secret, and encrypted readers and inspect real DOM/network/access behavior.
- Test old producer/new consumer and new producer/old consumer negotiation plus independent rollback.
- Update handoff, PRD, release checklist, product copy, repo docs, schemas, and skill together.

## Investigation targets
**Required** (read before coding):
- `/Users/gordon/work/gno.sh/docs/handoffs/gno-publish-artifact-contract.md` — cross-repo contract source
- `/Users/gordon/work/gno.sh/docs/prd/publish-artifact-upload.md:80` — stale exclusion to reconcile
- `/Users/gordon/work/gno.sh/docs/release-readiness-checklist.md:132` — release evidence contract
- `docs/PUBLISHING.md` — GNO publishing user guide
- `assets/skill/SKILL.md` — agent publishing guidance
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx` — hosted docs source

**Optional** (reference as needed):
- `scripts/docs-verify.ts` — repo docs verification
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts` — product/feature claims

## Key context
Both repos require their own commits, PRs, gates, and rollback points. Production deployment happens only after gno.sh merge and explicit release/deploy authorization; local QA is mandatory before that boundary.

## Acceptance
- [ ] Real producer artifacts render correct `<img>` DOM in public, secret, and encrypted readers; secret authorization and encrypted no-plaintext guarantees are captured.
- [ ] Byte-limit, corrupt digest, MIME spoof, traversal, unsupported SVG, missing asset, raw sentinel, retry, rollback, and cleanup proofs pass.
- [ ] GNO full gates and gno.sh `check`, `typecheck`, tests, and `smoke:publish:gno` pass.
- [ ] Independent version negotiation and rollback are demonstrated without breaking asset-free capsules.
- [ ] All repo/hosted docs, handoff/PRD/checklist, schemas, CHANGELOG, product copy, and skill agree; driven local and authorized production QA evidence is retained.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
