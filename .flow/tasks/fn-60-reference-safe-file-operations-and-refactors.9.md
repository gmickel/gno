---
satisfies: [R7]
---
# fn-60-reference-safe-file-operations-and-refactors.9 Prove refactor safety and reconcile every documentation surface

## Description
Complete the feature with adversarial fixtures, failure/concurrency proof, live workspace QA, documentation and schema reconciliation, skill autoresearch, hosted gno.sh updates, and release evidence. This task verifies the whole safety promise; it does not add another operation.

**Size:** M
**Files:** `test/core/`, `test/serve/`, `test/sdk/`, `test/mcp/`, `spec/`, `docs/`, `README.md`, `CHANGELOG.md`, `assets/skill/`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`, `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`

### Approach
- Run the complete reference matrix plus stale/concurrent/failure-injection scenarios.
- Drive rename/move preview and apply against a disposable real workspace; capture proof of rewritten links, rollback, and sync recovery.
- Update every contract and truth surface in the same change set; run skill autoresearch because CLI/MCP retrieval guidance changes.
- QA gno.sh locally and, after its own merge/deploy authorization, verify production separately.

### Investigation targets
**Required** (read before coding):
- `docs/WEB-UI.md:366` — current warning-only promise
- `docs/API.md` — existing refactor endpoints
- `docs/MCP.md` — workspace write guidance
- `docs/SDK.md` — SDK operation guidance
- `assets/skill/SKILL.md` — installed agent retrieval/operation guidance
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx` — hosted docs source

**Optional** (reference as needed):
- `scripts/docs-verify.ts` — documentation verification
- `docs/adr/001-scholarly-dusk-design-system.md` — live UI QA criteria

### Key context
Repository docs and gno.sh are separate truth surfaces. A green build is not live QA. No production deployment occurs without the release/deploy authorization applicable at implementation time.

## Acceptance
- [ ] Full link grammar, stale-plan, contention, interruption, rollback, and sync-pending suites pass with deterministic receipts.
- [ ] Disposable-workspace QA captures before/preview/after evidence and proves no unrelated bytes changed.
- [ ] `bun run lint:check`, `bun test`, relevant E2E/CLI/API/MCP gates, and docs verification pass.
- [ ] Specs, schemas, README, docs, CHANGELOG, skill assets, and hosted gno.sh pages describe the same safety boundary.
- [ ] Skill autoresearch reaches its required score or records a justified no-change result; gno.sh local gates and driven page QA pass.


## Done summary
Completed adversarial, failure-path, migration, documentation, skill, hosted-site, and real runtime verification for reference-safe rename/move. Added a shared grammar fixture matrix, deterministic disposable-workspace QA harness, stale-plan/lock/rollback/sync-pending proofs, and corrected schema-version assertions for migration 26. Reconciled README, API, SDK, MCP, Web UI, CHANGELOG, project/user skill guidance, and gno.sh truth surfaces. Live Web UI QA proved exact-digest rename and move, reference rewrites, byte preservation, and unrelated-file immutability.
## Evidence
- Commits: 9165ab26
- Tests: bun test test/core/file-refactor-adversarial.test.ts test/core/file-refactors.test.ts test/core/file-refactor-impact.test.ts test/core/file-refactor-planner.test.ts (40 pass), bun scripts/file-refactor-adversarial-qa.ts (6/6 pass), bun test test/store/clipper-store.test.ts test/store/adapter.test.ts (50 pass), bun run prerelease (3826 pass, 2 platform/E2E skips, 0 fail; docs/package/sentinel pass), bun run eval (103 evals, 80%, threshold 70%), bun run test:e2e (Web UI smoke passed), gno skill autoresearch (47/47, 100%), live disposable Web UI rename/move QA with POST 200, exact plan digest, reference rewrite, byte/hash preservation, and zero browser errors, gno.sh bun run check && bun run typecheck && bun run build; driven desktop/mobile docs and feature-page QA
- PRs: