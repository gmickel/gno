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

Production release HOLD: verify actual backup retention and restore reconciliation, ship policies with product, set legal effective date on release, and perform production QA after authorized deployment. No production publishing or configuration mutations performed.

Evidence under .flow/tmp/qa-fn-153-publishing-permissions-public and /home/gordon/.cache/agent-tmp/fn153/{worker-smoke,backend,invite-qa}. During initial site checks an unrelated ignored fn-4 cognitive-aid artifact received whitespace-only formatting; excluded from commits. Concurrent fn-160 planning work and unrelated untracked artifacts preserved.
## Evidence
- Commits: 8eb2ee10b3696915398030d8bbd9fee6da686a0c, 525d2c75355b911ff422d9ae73378bab874cf7fd
- Tests: baseline: red (pre-edit GNO bun test: inherited large-graph timeout; focused pre-edit retry passed), baseline: red (pre-edit site bun run check: unrelated ignored fn-4 artifact formatting; disclosed whitespace-only formatting edit), bun run lint:check (GNO: exit 0), bun run build:spa (GNO: exit 0; regenerated required production snapshot), bun test (GNO final: exit 0; 5232 passed, 2 expected skips), bun test test/serve/spa-snapshot-freshness.test.ts (committed snapshot: 2 passed), bun run check (gno.sh final: exit 0), bun run typecheck (gno.sh: exit 0), bun run test (gno.sh final: exit 0; 328 passed, 28 integration-only skips), bun run test:integration (gno.sh: exit 0; 28 PostgreSQL/MinIO tests passed), bun run build (gno.sh: exit 0), running-app browser QA: /home/gordon/.cache/agent-tmp/fn153/worker-smoke/evidence.json, running-app HTTP and fresh-worker QA: /home/gordon/.cache/agent-tmp/fn153/backend/LIVE-QA.md, whole-app restart QA: /home/gordon/.cache/agent-tmp/fn153/backend/whole-app-restart-results.json (all withdrawn modes remain 404; active copy/shared asset survive; scrubbed deletion receipt persists), Final follow-up GNO lint:check and bun test: exit 0; 5233 pass, 2 expected skips, 0 fail, Final follow-up gno.sh check, typecheck, test, build: exit 0; 329 pass, 28 integration-only skips, Live QA follow-ups: encrypted export/download desktop1280x633 and mobile375x633; Team encrypted upload/decrypt/navigation/unpublish; personal invite upload/publish/anonymous denial/unpublish; Free defaults and rejected private artifacts; honest encrypted counts after refresh, Docs copy verified by actual Control+v into scratch textarea, exact expected CLI command
- PRs: