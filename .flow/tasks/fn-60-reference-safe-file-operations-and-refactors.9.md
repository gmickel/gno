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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
