---
satisfies: [R2, R6, R7]
---
# fn-118-cloud-placeholder-safe-indexing.4 Finalize contracts, performance thresholds, documentation, and hosted-site parity

## Description
Re-run the physical benchmark against the finished behavior, publish only evidence-supported contracts, and update the complete user-facing documentation chain (R2/R6/R7).

Task 1 established a measured blocker for the naive candidate: an extra availability check for every discovered file added +15.2323% median on the 5,000-file all-local corpus, exceeding the proposed <=10% local-mode budget. The candidate to reuse traversal metadata flags and recheck only content actually consumed or changed is unproven; do not treat it as a performance pass. OneDrive cloud-placeholder support remains unclaimed unless this task obtains new dedicated physical evidence.

<!-- Updated by plan-sync: fn-118-cloud-placeholder-safe-indexing.1 measured naive per-file availability checks at +15.2323%, not the planned acceptable local-mode approach -->

**Size:** M
**Files:** CLI/config/receipt specs and schemas, tests, README/CHANGELOG/docs/glossary, tracked research receipt, downstream `~/work/gno.sh` docs/product pages
**Touches:** [spec/**, docs/**, README.md, CHANGELOG.md, GLOSSARY.md, research/file-provider/**, ../gno.sh/src/**]

### Approach
- Re-run task 1 protocol on the implemented `any` and `local` modes and enforce the 3%/10% median scan thresholds. Do not use the measured-failing naive per-discovered-file availability pass; physically measure any traversal-metadata reuse design before accepting it.
- Document only providers/states supported by physical evidence, including stale-index and unsupported-platform behavior; do not claim OneDrive cloud-placeholder support without a dedicated supported-state result.
- Keep source availability distinct from egress policy in CLI naming, glossary, receipts, and marketing/docs copy.
- Walk the downstream gno.sh documentation and driven-QA/deploy chain required by repo instructions.

### Investigation targets
**Required** (read before implementation):
- `spec/cli.md` — public CLI/config contract
- `docs/CONFIGURATION.md:27-45` — collection configuration
- `docs/DAEMON.md:13-32` — scheduled/watch behavior
- `docs/ARCHITECTURE.md:171-195` — ingestion architecture
- `GLOSSARY.md:105-119` — egress terminology boundary
- `~/work/gno.sh/src/lib/gno-docs.tsx` — hosted docs source

**Optional** (reference as needed):
- `docs/TROUBLESHOOTING.md` — provider/unsupported filesystem guidance
- `~/work/gno.sh/src/lib/product-pages.ts` — collection/daemon product claims
## Acceptance
- [ ] Final physical benchmark proves unchanged `any` mode <=3% median scan regression and `local` mode <=10% overhead on the controlled all-local corpus, or the task stops with a measured blocker. It must not rely on the task 1 naive extra-per-discovered-file availability-check design, which already measured +15.2323%.
- [ ] CLI/config/structured receipts and schemas are contract-tested.
- [ ] README, CHANGELOG, glossary, user docs, and gno.sh state the exact evidence-supported guarantee and caveats; OneDrive cloud-placeholder support is not claimed without dedicated physical evidence.
- [ ] Repo gates, docs verification, local driven website QA, production deployment verification, and live driven QA complete before release claims.

- [ ] R2 contracts finalized
- [ ] R6 post-implementation thresholds proven
- [ ] R7 repo and hosted docs aligned and QA verified
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
