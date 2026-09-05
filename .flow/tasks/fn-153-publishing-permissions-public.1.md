---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14]
---
# fn-153-publishing-permissions-public.1 Implement publishing permissions, public revocation, and a usable Studio

## Description
TBD

## Acceptance
Every R-ID in the parent spec's Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Implemented explicit local export access and hosted reviewed publishing, stable content updates, distinct copies, access rotation, shared read denial, and durable owner-scoped deletion. Studio is library-first with retained history and cleanup status; reader navigation, policy/help, migration and rollback documentation are updated in both repositories.

stage: impl-review - skipped(config: REVIEW_MODE=none; explicit user instruction)

### Commits and workspaces

- GNO `545d7b1722289a3669662891964fc044c451b530..8eb2ee10b3696915398030d8bbd9fee6da686a0c` in `/home/gordon/work/gno`.
- Hosted `84219091a1b7bfaff83e14333cb3bfd5d743e3fc..3c26c5d29ef420bbe834a2a2ca3ccccac7dd5729` in `/home/gordon/work/gno.sh`.
- No push, deployment, production mutation, or real-publication operation was performed by this worker. Local synthetic QA only. Unrelated untracked GNO Flow artifacts were preserved and excluded from commits with conductor-authorized explicit staging.

### Verification

GNO lint passed. Final `bun test`: 5,232 passed, two expected platform/opt-in skips, zero failed. The first post-edit suite caught the required production SPA snapshot; `bun run build:spa` regenerated it, the full rerun passed, and the committed snapshot freshness check passed (2 tests). Logs: `.flow/tmp/fn153-final-lint.log`, `fn153-final-test-after-snapshot.log`, `fn153-build-spa.log`, `fn153-committed-snapshot-check.log`. Pre-commit lint also passed.

Hosted `bun run check`, `bun run typecheck`, `bun run test` (328 passed; 28 integration-only skips), `bun run test:integration` (28 real PostgreSQL/MinIO tests), and `bun run build` passed. Final check/test receipts are `/home/gordon/.cache/agent-tmp/fn153/final-site-check-after-fix.log` and `final-site-test-after-fix.log`; typecheck/integration/build receipts use `final-site-typecheck.log`, `final-site-test-integration.log`, `final-site-build.log` in the same directory. The first final test run exposed obsolete policy-copy assertions; these were corrected to require self-service withdrawal and retain the encryption boundary. Two cleanup files required formatting. No runtime fix followed these final gates.

Green full-gate receipts: GNO `.flow/tmp/green-receipts/8eb2ee10-unittest.json`; hosted `.flow/tmp/green-receipts/3c26c5d2-{unittest,integration,build}.json`.

Baseline: red. GNO pre-edit full suite had one inherited large-graph timeout (5,222 passed, 2 skipped); focused pre-edit retry passed and the final full suite passes. Site pre-edit typecheck/unit/integration/build passed; check failed on an ignored, unrelated `.flow/artifacts/fn-4-fix-copied-structured-query-newline/pr-cognitive-aid/fn4-895f30686893.json` formatting issue. I accidentally formatted that ignored artifact while the conductor was replying not to touch it. The edit was whitespace-only, was reported immediately, and was not committed; no tracked original was available to restore. `/tmp` quota failure was handled by moving new logs to the approved home scratch directory; no files were removed.

### Acceptance evidence

| Criteria | Evidence |
|---|---|
| R1, R7, R9 | Shared note/collection dialog tests plus real local export: no initial mode, cancel emits no request, audience acknowledgment, exact public artifact download, missing/mismatched encryption inputs emit no request. Existing API/CLI defaults retained. |
| R2, R3, R5, R12 | `publish-operation.test.ts`, `publish-functions-permissions.test.ts`, `publish-reviewed-service.test.ts`, Studio tests, lifecycle DB cases. Live artifact draft/review, egress-policy rejection retains draft, explicit update preserves URL/body replacement, explicit copy creates distinct live URL. Server owner/admin organization authority and explicit encryption re-export boundaries are enforced. |
| R4, R10 | All four actual HTTP readers 200 to 404 after withdrawal; asset and machine projections deny even conditional requests. Persisted cleanup fault remains denied; fresh worker process cleans payload/history and scrubs receipt, while independently referenced object and its live URL survive. Migration, null pointer, source-only deletion, CAS/races, legal hold, fault retries, and shared-object cases are covered by real PostgreSQL/MinIO tests. |
| R6, R8, R11 | Live compact Studio, retained history, deleting state (no republish), automatic Deleted completion, mobile Studio keyboard Publish/Enter review. Reader full-row hover, Tab focus, Enter note switch, mobile switch and native emulated touchscreen tap; no claimed physical-device test. |
| R13 | GNO docs/specs and hosted help/Terms/Privacy updated together. Changed hosted pages were driven on desktop/mobile; docs copy button clicked (clipboard contents not independently checked). Legal effective date remains unchanged until shipping. |
| R14 | Green combined gates plus independent browser/HTTP/worker evidence from running synthetic apps. Production is a separate release HOLD as below. Whole-app restart also passed: all withdrawn modes remained 404, while the canonical shared-asset URL and Studio-created copy remained 200; scrubbed deletion receipt persisted. |

Browser evidence: `/home/gordon/.cache/agent-tmp/fn153/worker-smoke/summary.md` and `evidence.json`. Backend live evidence: `/home/gordon/.cache/agent-tmp/fn153/backend/LIVE-QA.md`, `live-api-results.json`, `live-recovery-results.json`, `live-tenant-results.json`. Actual HTTP tenant checks prove personal private content is owner-only; organization private readers include authorized members, while Studio management excludes reader-only membership and other owners. Invite/encrypted upload and cleanup failures were not browser journeys; their evidence is service/HTTP/integration, not a browser claim. Earlier Vite development collisions cleared after concurrent tooling paused; stable browser console was clean.

### Release boundary and remaining work

Do not deploy from this implementation receipt. `gno.sh/docs/PUBLISHING_LIFECYCLE_RUNBOOK.md` records migration, cleanup, guarded rollback and backup/restore requirements. Actual provider backup/retention/encryption-at-rest and current-denial recovery after an older restore remain unverified. Do not promise immediate backup erasure or reopen readers after restore without reconciled denial state. Update legal effective date only when shipping; production deployment, exact deployed-commit checks and post-deploy QA remain with the conductor and require authorization. No plan or implementation review was run, as explicitly requested.

Development acceptance is verified. Whole-app restart receipt: `/home/gordon/.cache/agent-tmp/fn153/backend/whole-app-restart-results.json`. The raw backend fixture initially used a noncanonical owner slug that existing startup normalization changed; the authoritative before/after restart used the canonical route and a Studio-created publication control. This required no code or environment change. Publishing/release operations remain outside this worker handoff.
## Evidence
- Commits: 546b69aa165a1276c638c1ac31a2a4ea75c3d57a, 8eb2ee10b3696915398030d8bbd9fee6da686a0c
- Tests: baseline: red (pre-edit GNO bun test: inherited large-graph timeout; focused pre-edit retry passed), baseline: red (pre-edit site bun run check: unrelated ignored fn-4 artifact formatting; disclosed whitespace-only formatting edit), bun run lint:check (GNO: exit 0), bun run build:spa (GNO: exit 0; regenerated required production snapshot), bun test (GNO final: exit 0; 5232 passed, 2 expected skips), bun test test/serve/spa-snapshot-freshness.test.ts (committed snapshot: 2 passed), bun run check (gno.sh final: exit 0), bun run typecheck (gno.sh: exit 0), bun run test (gno.sh final: exit 0; 328 passed, 28 integration-only skips), bun run test:integration (gno.sh: exit 0; 28 PostgreSQL/MinIO tests passed), bun run build (gno.sh: exit 0), running-app browser QA: /home/gordon/.cache/agent-tmp/fn153/worker-smoke/evidence.json, running-app HTTP and fresh-worker QA: /home/gordon/.cache/agent-tmp/fn153/backend/LIVE-QA.md, whole-app restart QA: /home/gordon/.cache/agent-tmp/fn153/backend/whole-app-restart-results.json (all withdrawn modes remain 404; active copy/shared asset survive; scrubbed deletion receipt persists)
- PRs: