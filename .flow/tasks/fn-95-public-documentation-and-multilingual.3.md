---
satisfies: [R1, R2, R5, R6]
---
# fn-95-public-documentation-and-multilingual.3 Propagate and verify truthful public documentation

## Description
Deliver propagate and verify truthful public documentation as one implementation-sized increment.

**Size:** M
**Files:** `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`, `/Users/gordon/work/gno.sh/src/lib/site-content.ts`, `/Users/gordon/work/gno.sh/src/lib/gno-comparisons.tsx`, `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`, `/Users/gordon/work/gno.sh/src/routes/pricing.tsx`, `/Users/gordon/work/gno.sh/src/routes/faq.tsx`, `/Users/gordon/work/gno.sh/src/routes/install.tsx`

### Approach
- Apply the same evidence-backed claims to canonical hosted-site sources, pricing/FAQ/install/comparison surfaces, without treating the legacy website directory as production.
- Deploy gno.sh only after both repos are committed and run live HTTP/service/revision checks.
- Define release blocking behavior: a failed production docs deployment prevents claiming public alignment but does not falsify local code status.
- Treat `PUBLIC_TRUTH` as the exact contract only for its five anchored local claim classes: current release (`1.13.0`), Bun runtime (`>=1.3.0`), supported platforms (macOS/Linux/Windows), default embedding model (`Qwen3-Embedding-0.6B-GGUF`), and the dated 2026-04-06 13-query general-embedding evidence. It does not certify multilingual conclusions, pricing, connector behavior, privacy wording, or remote-model/product claims; align those with task 2's qualified prose, released behavior, and the linked immutable evidence instead.
- Do not extend the meaning of `verifyRepositoryPublicTruth`: it collects anchored `README.md`, `docs/**`, and legacy `website/**` files only. `bun run docs:truth` / `bun run docs:verify` prove that local scope, not gno.sh. Audit hosted claims independently before deployment; do not add anchors or state that the local verifier scans gno.sh.
- Use the audited hosted-source ownership map: `gno-docs.tsx` owns command/API/integration prose; `site-content.ts` owns landing-page features and FAQ snippets; `gno-comparisons.tsx` owns competitor claims; `product-pages.ts` owns product-page and legacy-imported FAQ claims; `pricing.tsx`, `faq.tsx`, and `install.tsx` own billing, structured FAQ metadata, and install-page claims. Preserve the distinction between local GNO and the optional paid gno.sh publishing product; qualify remote model-server support without implying remote corpus access.
- Document the source-ownership boundary explicitly: `website/` is a locally verified legacy surface, while `/Users/gordon/work/gno.sh` is the canonical hosted-site source.

<!-- Updated by plan-sync: fn-95-public-documentation-and-multilingual.1 used verifyRepositoryPublicTruth for anchored local surfaces; it does not scan gno.sh -->
<!-- Updated by plan-sync: fn-95-public-documentation-and-multilingual.2 completed the repository truth pass; PUBLIC_TRUTH owns five anchored local claim classes, not hosted or multilingual/product prose -->

### Investigation targets
**Required** (read before coding):
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`
- `/Users/gordon/work/gno.sh/src/lib/site-content.ts`
- `/Users/gordon/work/gno.sh/src/lib/gno-comparisons.tsx`
- `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`
- `/Users/gordon/work/gno.sh/src/routes/pricing.tsx`
- `/Users/gordon/work/gno.sh/src/routes/faq.tsx`
- `/Users/gordon/work/gno.sh/src/routes/install.tsx`
- `/Users/gordon/work/gno.sh/scripts/deploy-prod.sh`

**Optional** (reference as needed):
- `scripts/public-truth.ts` and `scripts/docs-verify.ts` (read-only local contract and verification scope)
- `evals/README.md`, `docs/CONFIGURATION.md`, and `docs/HOW-SEARCH-WORKS.md` (task 2's qualified model and multilingual evidence)

## Acceptance
- [ ] Hosted docs, product/price/FAQ/install/comparison claims match released behavior and canonical evidence; they distinguish local GNO from optional paid gno.sh publishing, remote model inference from remote corpus access, and explicitly mark deferred capabilities.
- [ ] Deployment proves HTTPS, active service, and remote revision equals gno.sh origin/main.
- [ ] The documented source-ownership map covers the audited hosted owners (`gno-docs`, `site-content`, `gno-comparisons`, `product-pages`, pricing/FAQ/install routes) and prevents legacy `website/` from becoming a competing truth source.
- [ ] `bun run docs:truth` and `bun run docs:verify` pass for their local anchored scope. Before deployment, independently audit gno.sh against the exact `PUBLIC_TRUTH` facts it covers and task 2's qualified multilingual/product evidence; do not represent either local verifier as a hosted-site check.


## Done summary
Aligned the canonical gno.sh hosted sources with released GNO behavior and dated multilingual evidence, including exact MCP targets, remote-inference/privacy boundaries, loopback API scope, fine-tuned expansion semantics, implemented publishing tiers, footer behavior, and desktop/package facts. Added source-content regression coverage; production deploy plus HTTPS, service, and remote-revision verification is intentionally deferred to land after commit 21c605f4dd698804bae0f2ce67648ec0e7cfce0a merges into gno.sh main.
## Evidence
- Commits: 21c605f4dd698804bae0f2ce67648ec0e7cfce0a
- Tests: bun run format (gno.sh), bun run check (gno.sh), bun run typecheck (gno.sh), bun test (gno.sh: 81 pass, 5 skip), bun run build (gno.sh: 67 pages prerendered), bun run lint:check, bun run docs:truth, bun run docs:verify (13 pass, 2 model-cache skips), .flow/bin/flowctl validate --spec fn-95-public-documentation-and-multilingual --json, GATE_SKIPPED:unittest:docs-only - cumulative GNO diff classified tier-B (no executable GNO paths touched), DEPLOY_DEFERRED: production HTTPS/service/revision verification waits for gno.sh commit 21c605f to merge to main during land
- PRs: