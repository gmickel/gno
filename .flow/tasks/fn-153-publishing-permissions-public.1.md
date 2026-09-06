---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14]
---
# fn-153-publishing-permissions-public.1 Implement publishing permissions, public revocation, and a usable Studio

## Description
TBD

## Acceptance
Every R-ID in the parent spec's Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Implemented explicit local access review, plan-aware hosted drafts, supported visibility changes, explicit update/copy, tenant authorization, shared read denial, durable deletion and recovery, library-first Studio, reader navigation feedback, and policy/docs across GNO and gno.sh.

Final QA fixed short-window encrypted export, misleading encrypted content counts, and the pending-deletion republish prompt. Real browser journeys and HTTP/worker tests cover R1-R14 in isolated synthetic environments. Desktop, mobile viewport, keyboard, pointer and emulated touch evidence captured.

Final GNO checks: lint:check and 5233 tests pass (2 expected skips). Final hosted check, typecheck, build and 329 tests pass; 28 real PostgreSQL/MinIO integration tests passed before the UI-only count follow-up. GNO code 525d2c75; hosted code 3e93e13. No plan or implementation review by explicit user request.

Release preparation, 2026-09-06: the blanket backup/restore HOLD was removed after read-only inspection of both hosts and user-supplied Hetzner screenshots showing automatic backups disabled. No host-managed content backups were found. Manual snapshots remain unverified; retention and restore reconciliation apply to any copy used, including a pre-migration backup. No production mutations had been performed at that preparation stage; Gordon subsequently authorized the release and deployment below.

Release completed, 2026-09-06: GNO PR #220 merged at `1d6e8ba0`; release PR #221 merged at `932d7ec4`, tagged and published as v2.1.0. The coordinated Publish run `34011785628` passed every job, including Windows desktop and signed/notarized macOS desktop with a signed launch test. The published npm archive is byte-for-byte equal to the CI-tested archive (SHA-256 `b8c97ab4c81ad7d4f3b4925ff07cb91b19e5bfd95be6f3a4ab58703ca41e6d1c`). All five GitHub release asset digests match the downloaded CI artifacts. The final local prerelease suite passed 5242 tests with 2 expected skips; the corrected release documentation guard and 2.1.0 package smoke also passed.

gno.sh PR #53 merged and deployed at `17d71fb` with the September 6 policy date. The additive lifecycle schema, public/restricted fixture hashes and denial headers, docs, policies, and reader navigation passed production verification. Service restart now runs database/cleanup bootstrap before readiness completes; the restart and repeated fixture verification passed. Production runtime identity remains `.output/REVISION=17d71fb`; source HEAD `444fc82` includes only the subsequent operations runbook update from PR #54. The root-only pre-migration recovery copy remains retained pending authorized cleanup. Authenticated destructive lifecycle journeys were verified in isolated local fixtures, not repeated on customer publications.

Release and production receipts are under `.flow/artifacts/fn-153-publishing-permissions-public/release/`. fn-162 tracks a separate P2 mobile reader home-control/visibility-badge overlap; it does not block the publishing lifecycle release. fn-153 is closed after publication and production verification.

Evidence under .flow/tmp/qa-fn-153-publishing-permissions-public and /home/gordon/.cache/agent-tmp/fn153/{worker-smoke,backend,invite-qa}. During initial site checks an unrelated ignored fn-4 cognitive-aid artifact received whitespace-only formatting; excluded from commits. Concurrent fn-160 planning work and unrelated untracked artifacts preserved.
## Evidence
- Commits: 8eb2ee10b3696915398030d8bbd9fee6da686a0c, 525d2c75355b911ff422d9ae73378bab874cf7fd, 1d6e8ba08820f2027cbea2b6b4857b2d7fd62c44, 932d7ec43a4810fa6af02de07f4f9aebaf183ec9
- Tests: baseline: red (pre-edit GNO bun test: inherited large-graph timeout; focused pre-edit retry passed), baseline: red (pre-edit site bun run check: unrelated ignored fn-4 artifact formatting; disclosed whitespace-only formatting edit), bun run lint:check (GNO: exit 0), bun run build:spa (GNO: exit 0; regenerated required production snapshot), bun test (GNO final: exit 0; 5232 passed, 2 expected skips), bun test test/serve/spa-snapshot-freshness.test.ts (committed snapshot: 2 passed), bun run check (gno.sh final: exit 0), bun run typecheck (gno.sh: exit 0), bun run test (gno.sh final: exit 0; 328 passed, 28 integration-only skips), bun run test:integration (gno.sh: exit 0; 28 PostgreSQL/MinIO tests passed), bun run build (gno.sh: exit 0), running-app browser QA: /home/gordon/.cache/agent-tmp/fn153/worker-smoke/evidence.json, running-app HTTP and fresh-worker QA: /home/gordon/.cache/agent-tmp/fn153/backend/LIVE-QA.md, whole-app restart QA: /home/gordon/.cache/agent-tmp/fn153/backend/whole-app-restart-results.json (all withdrawn modes remain 404; active copy/shared asset survive; scrubbed deletion receipt persists), Final follow-up GNO lint:check and bun test: exit 0; 5233 pass, 2 expected skips, 0 fail, Final follow-up gno.sh check, typecheck, test, build: exit 0; 329 pass, 28 integration-only skips, Live QA follow-ups: encrypted export/download desktop1280x633 and mobile375x633; Team encrypted upload/decrypt/navigation/unpublish; personal invite upload/publish/anonymous denial/unpublish; Free defaults and rejected private artifacts; honest encrypted counts after refresh, Docs copy verified by actual Control+v into scratch textarea, exact expected CLI command
- Release verification: https://github.com/gmickel/gno/actions/runs/34011785628 (all eight jobs passed), npm archive equality and all five GitHub asset digests verified, production lifecycle schema/bootstrap restart and public/restricted fixtures verified, desktop/mobile browser QA of changed production pages passed
- PRs: https://github.com/gmickel/gno/pull/220, https://github.com/gmickel/gno/pull/221, https://github.com/gmickel/gno.sh/pull/53, https://github.com/gmickel/gno.sh/pull/54
