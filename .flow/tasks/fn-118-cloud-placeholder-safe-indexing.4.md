---
satisfies: [R2, R6, R7]
---
# fn-118-cloud-placeholder-safe-indexing.4 Finalize contracts, performance thresholds, documentation, and hosted-site parity

## Description
Re-run the physical benchmark against the finished behavior, publish only evidence-supported contracts, and update the complete user-facing documentation chain (R2/R6/R7).

Task 1 established a measured blocker for the naive candidate: an extra availability check for every discovered file added +15.2323% median on the 5,000-file all-local corpus, exceeding the proposed <=10% local-mode budget. Task 3 instead implements hierarchical, per-directory availability classification, memoized for each operation; it does not add a per-discovered-file availability syscall, while the guarded content boundary still rechecks every consumed file. Benchmark that shipped design rather than treating traversal-metadata reuse as a pending candidate. OneDrive cloud-placeholder support is proven only for the tested OS/provider configuration and both installed immediate SharePoint library roots; unavailable or irreproducible states remain explicitly unclaimed.

<!-- Updated by plan-sync: fn-118-cloud-placeholder-safe-indexing.3 used memoized per-directory classification plus guarded content rechecks, not the planned unproven traversal-metadata-reuse candidate -->
<!-- Updated by plan-sync: fn-118-cloud-placeholder-safe-indexing.1 measured naive per-file availability checks at +15.2323%, not the planned acceptable local-mode approach -->
<!-- Updated by plan-sync: fn-118-cloud-placeholder-safe-indexing.5 proved guarded OneDrive cloud-only refusal in both installed immediate library roots, not the planned unclaimed state -->

**Size:** M
**Files:** CLI/config/receipt specs and schemas, tests, README/CHANGELOG/docs/glossary, tracked research receipt, downstream `~/work/gno.sh` docs/product pages
**Touches:** [spec/**, docs/**, README.md, CHANGELOG.md, GLOSSARY.md, research/file-provider/**, ../gno.sh/src/**]

### Approach
- Re-run task 1 protocol on the implemented `any` and `local` modes and enforce the 3%/10% median scan thresholds. Do not use the measured-failing naive per-discovered-file availability pass; physically measure the implemented hierarchical per-directory classification and guarded content-recheck design before accepting it.
- Document only providers/states supported by physical evidence, including stale-index and unsupported-platform behavior; state OneDrive cloud-placeholder support only for the tested configuration and the two independently validated immediate library roots.
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
- [ ] README, CHANGELOG, glossary, user docs, and gno.sh state the exact evidence-supported guarantee and caveats; OneDrive cloud-placeholder support is documented only for the tested configuration and the two independently validated immediate library roots.
- [ ] Repo gates, docs verification, local driven website QA, production deployment verification, and live driven QA complete before release claims.

- [ ] R2 contracts finalized
- [ ] R6 post-implementation thresholds proven
- [ ] R7 repo and hosted docs aligned and QA verified
## Done summary
Finalized source-availability CLI/config/receipt contracts, schemas, tests, benchmark evidence, and evidence-qualified GNO and hosted-site documentation. The controlled 5,000-file production-walker comparison passed both R6 gates without contaminated samples: current `any` -1.1280% versus pre-implementation `any` (<=3%), and hierarchical `local` +1.1841% versus current `any` (<=10%).

GNO implementation commit: `fc2b97d8`. Hosted documentation shipped through gno.sh PR #32, squash-merged as `953be0ba3476c4d7b87ed6250ccdb0e0fa6ba98d`, and deployed with the repository production script. Production verification: `https://gno.sh` HTTP 200; `gno-sh` active; remote HEAD exactly matches `origin/main`; only the expected untracked remote `.env.production` remains.

Driven production QA exercised `/docs/configuration#source-availability` and `/features/collections` at 1280px and 390px. Exact -1.1280%/+1.1841% evidence, tested macOS/Google Drive/iCloud Drive/OneDrive SharePoint scope, fixture caveat, and availability-versus-egress distinction rendered; the configuration anchor landed at the expected heading; Collections had no horizontal overflow. Screenshots: `/tmp/fn118-gno-sh-prod-config.png`, `/tmp/fn118-gno-sh-prod-config-mobile.png`, `/tmp/fn118-gno-sh-prod-collections.png`, `/tmp/fn118-gno-sh-prod-collections-mobile.png`. Browser error inspection was clean.

QA caveat outside changed content: the existing mobile docs navigation contributes a 7px document-width overflow (390px viewport, 397px document), matching the local pre-deploy observation. No GNO package release was performed; the conductor owns the GNO PR/merge/version/tag/publish sequence.

stage: impl-review - skipped(config: REVIEW_MODE=none)
stage: plan-sync - skipped(empty: no downstream todo tasks)
## Evidence
- Commits: fc2b97d8429e12063593e33571702e3308415835
- Tests: bun run lint:check, bun test test/scripts/macos-file-provider-smoke.test.ts test/spec/schemas/source-availability-receipt.test.ts test/ingestion/source-availability test/serve/watch-snapshot-availability.test.ts (124 passed), physical benchmark: pre-implementation FileWalker d0e77f15 vs current any/local on one owned 5000-file corpus, 2 warmups + 9 interleaved samples/lane, no contamination; any -1.1280%, local +1.1841%, bun scripts/macos-file-provider-smoke.ts benchmark-local --corpus-files 5000, bun scripts/docs-verify.ts (15 passed, 0 failed, 2 model-dependent skipped), bun test (4341 passed, 2 skipped, 0 failed), bun scripts/macos-file-provider-smoke.ts --help, gno.sh: bun run check, gno.sh: bun run typecheck, gno.sh: bun run build, gno.sh local driven QA: http://localhost:3344/docs/configuration#source-availability and /features/collections at desktop and 390px, gno.sh production deploy: DEPLOY_HOST=root@178.104.180.89 ./scripts/deploy-prod.sh, production verification: https://gno.sh HTTP 200; gno-sh active; remote HEAD 953be0ba3476c4d7b87ed6250ccdb0e0fa6ba98d equals origin/main, gno.sh production driven QA: https://gno.sh/docs/configuration#source-availability and /features/collections at 1280px and 390px
- PRs: https://github.com/gmickel/gno.sh/pull/32
