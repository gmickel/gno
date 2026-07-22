---
satisfies: [R1, R2, R4, R6]
---
# fn-95-public-documentation-and-multilingual.2 Reconcile repository claims with measured evidence

## Description
Deliver reconcile repository claims with measured evidence as one implementation-sized increment.

**Size:** M
**Files:** `README.md`, `docs/CONFIGURATION.md`, `docs/HOW-SEARCH-WORKS.md`, `docs/FINE-TUNED-MODELS.md`, `evals/README.md`, `scripts/public-truth.ts`

### Approach
- Audit every current model, multilingual, connector, remote-access, paid, and latest-version claim against released behavior.
- Narrow multilingual language/metric claims to committed Qwen/Nemotron evidence and explicitly label the lexical-degradation benchmark as pending until fn-96.
- Preserve archival changelog text and add direct evidence links with fixture/runtime limitations.
- Wrap machine-owned current version, default-model, platform/runtime, and general-embedding benchmark summaries in the exact `<!-- public-truth:<claim-class> -->` / `<!-- /public-truth -->` anchors accepted by `verifyRepositoryPublicTruth`; leave nuanced prose unanchored.
- Use `PUBLIC_TRUTH`'s dated general-embedding evidence filenames and measured values in anchored summaries. Run `bun run docs:truth` and `bun run docs:verify` after the copy pass.

<!-- Updated by plan-sync: fn-95-public-documentation-and-multilingual.1 used PUBLIC_TRUTH/verifyRepositoryPublicTruth anchors and docs:truth, not an unstructured manifest -->

### Investigation targets
**Required** (read before coding):
- `README.md`
- `docs/CONFIGURATION.md`
- `docs/HOW-SEARCH-WORKS.md`
- `evals/README.md`
- `evals/multilingual.eval.ts`

**Optional** (reference as needed):
- `docs/comparisons`
### Key context
- The current multilingual eval is a placeholder/BM25 sanity lane; do not promote it into a general multilingual quality claim.

## Acceptance
- [ ] Current release and install examples match package metadata.
- [ ] Multilingual prose names languages, metrics, fixtures, models, limitations, and lexical caveat accurately.
- [ ] No repo marketing surface promises an unimplemented model, connector, remote, or paid capability.
- [ ] Machine-owned current claims use valid public-truth anchors and pass both `bun run docs:truth` and `bun run docs:verify`.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
