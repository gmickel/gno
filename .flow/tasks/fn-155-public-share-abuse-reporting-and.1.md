---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R8]
---
# fn-155-public-share-abuse-reporting-and.1 Implement public-share abuse reporting and administrator takedown

## Description
TBD

## Acceptance
Every R-ID in the parent spec's Acceptance Criteria is satisfied; judge this task against the spec criteria directly.

## Done summary
Implemented contextual email reports and a singleton-authorized publication moderation page in the isolated gno.sh checkout. Durable owner-scoped restrictions, exact-copy prevention, owner explanations, safe reinstatement, transactional audit receipts, and implemented retention ship with verified mailbox policy/help text.

Task: fn-155-public-share-abuse-reporting-and.1
Status: implementation and local QA complete; conductor owns shipping.
Product workspace: /home/gordon/work/gno.sh-fn155-release
Flow workspace: /home/gordon/work/gno-fn155-release
Product base: 649bc4c29f81d92184239c26fbf8dbadd6ad7a2c
Product commits: 38a2e3cc3ccd005f43117ef0f14a719ca7739eb9, 0856641a81aa4a1db6f492fb8a1f80bd885d81dd, ce901d4c0202650a8a35caa1272432cefef8645c, 1c340de22a7aa858843d0b79be4c8e021b97ae21
Flow base: d9287bde (no worker Flow tracked edits or commits).

baseline: green. Frozen install passed. Pre-edit check, typecheck, unit, real DB/object-store integration, and build each passed; logs baseline-*.log beside this summary. Final check/typecheck, unit (346 passed; DB suite intentionally gated there), integration (36 passed), and build passed at product HEAD. Logs: fn155-final-check.log, fn155-final-typecheck.log, fn155-final-test.log, fn155-final-test:integration.log, fn155-final-build.log. Product .flow/tmp/green-receipts holds HEAD receipts for unittest/integration/build. No full gates were skipped.

Acceptance coverage:
- R1: src/lib/moderation-contract.test.ts validates canonical public URLs, dropped query/fragment, unsupported/malformed paths, and fallback reporting. Reader action, report email draft and copy controls are implemented; opening a draft is explicitly not submission.
- R2/R3: src/lib/moderation-functions.test.ts drives real server handlers with mocked transport/session boundaries, forged identities, direct nonoperator calls, origin rejection, typed DB failure, and fail-closed operator runtime. Singleton MODERATION_OPERATOR_USER_ID is independent of billing/email/org roles and defaults empty.
- R2/R4/R5: src/lib/server/moderation.integration-case.ts verifies actual persisted reader/agent denial, owner Studio reason, owner access/rotate/update blocking, renamed exact import and owner deletion tombstone survival, cross-owner allowance, canonical URL lookup, and reinstatement retaining unpublish/deletion/revocation/expiry. Existing publish-lifecycle-read.integration-case.ts covers the shared operator guard across reader, historical and asset projections.
- R6: same integration file tests serialized conflicting takedowns, retries/stale state, trigger-injected audit rollback, and retention pruning while active blocks remain enforced. Content-free audit/inactive restriction retention is 90 days with startup/action/hourly pruning; reinstatement removes digests. Active blocks survive content cleanup.
- R7: terms/acceptable-use/privacy/report-abuse, legal processor list, publishing quickstart and visibility help, and docs/publish-moderation.md updated. Confirmed mailbox facts: ImprovMX forwards to Gordon's Gmail; Gordon sole reader; emails retained until manually deleted with no automatic mailbox schedule. Destination address is not published. No mailbox policy facts remain unverified.
- R8: real local integration path passed. Conductor is driving the synthetic app and owns final Flow QA receipt; no browser QA verdict claimed by worker.

Important release/runtime details:
- Production and configured-operator runtimes force DB readers, including when fallback is requested, to preserve durable denial. The former production-fallback unit expectation was intentionally updated in the second commit; initial final full suite caught that stale test, then the canonical suite passed after correction.
- Operator actions use POST, same-origin verification, server session identity, strict validation, expected revision, explicit confirmation and UUID idempotency key. Mutation + audit share the existing lifecycle transaction/lock. No report queue, anonymous submission API, auto-classifier, evidence store or new dependencies.
- Migration db/migrations/155-public-moderation.sql matches additive bootstrap schema. Active records have no source FK and survive deletion. Rollback/restore runbook requires denial reconciliation before readers resume; older builds that omit digest enforcement are unsafe for activation.
- Dev app remains running http://localhost:3345 (tool session 29701) against synthetic gno_sh_qa DB and gno-sh-fn155-qa bucket. Canonical public QA fixture after existing account bootstrap is /share/owner/db-agent-space (initial /share/fn155-owner/db-agent-space became stale and now 404); immutable target target-bddc3c118f38862324b4d4fc009f471a. Conductor has synthetic login details. Shared compose project fn155 uses PostgreSQL15455, MinIO19455/19456, MailHog11055/18055. Integration tests use separate gno_sh DB. Do not shut these down before conductor QA ends.

stage: impl-review - ran (claude-fable-5-1 medium; final SHIP at 1c340de; all three minor findings fixed)

Live-QA copy correction: neutral retained-source wording landed in the third commit after conductor observation; 22 focused Studio tests passed. All five canonical gates subsequently passed again at final HEAD ce901d4c0202650a8a35caa1272432cefef8645c. Final product working tree is clean. Conductor retains live QA/review/release ownership.

Conductor-requested bounded cleanup landed in 1c340de22a7aa858843d0b79be4c8e021b97ae21: lookup now identifies whether the target owns an active restriction (canReinstate), inherited blocks show an instruction and disabled action, successful refresh clears the prior explanation, and the runbook spells out pre-migration independent-copy limitations without introducing a scan. One meaningful inherited-sibling integration regression passed. Latest check/typecheck logs: fn155-review-check.log and fn155-review-typecheck.log. Canonical unit346, integration36, and build gates passed again at this final HEAD; receipts in product .flow/tmp/green-receipts/1c340de2-*.json. Conductor owns same-receipt re-review and QA completion; worker claims no verdict.

Fresh synthetic review fixtures (no QA reset/account changes): /share/owner/qa-review-original target-e445a5610028594987dfab063ab8cab3 and /share/owner/qa-review-sibling target-8a18b55876b31ff3f24bd54f17eaa54e. Created via real import and publishSourceWithService and verified to share source identity; conductor drives live actions. Original initial QA target was deleted/reinstated by conductor and remains unavailable as intended.

Conductor acceptance: live reader report and actual copied template; anonymous/ordinary operator denial; persisted takedown and five reader/agent route denials; owner reason, same-source and renamed exact-copy rejection; owner deletion then reinstatement remains denied; sibling restriction instruction/disabled action and successful governing-target reinstatement; cleared explanation; desktop/mobile owner/operator/policy views. Six policy/help routes driven with no product findings. Exact product QA HEAD: 1c340de22a7aa858843d0b79be4c8e021b97ae21. QA artifacts: .flow/tmp/qa-fn-155-public-share-abuse-reporting-and/. Initial public-route lookup mismatch was a renamed synthetic fixture, resolved and recorded; no open P0/P1. Asset/history paths covered by real integration, no browser asset fixture claimed.

stage: plan-sync - skipped(config: planSync.enabled != true)
stage: completion-review - skipped(policy: single task, all R1-R8 covered, per-task SHIP)
Tracker sync: n/a (bridge inactive).
## Evidence
- Commits: 38a2e3cc3ccd005f43117ef0f14a719ca7739eb9, 0856641a81aa4a1db6f492fb8a1f80bd885d81dd, ce901d4c0202650a8a35caa1272432cefef8645c, 1c340de22a7aa858843d0b79be4c8e021b97ae21
- Tests: baseline: green (bun run check; bun run typecheck; bun run test; bun run test:integration; bun run build), bun install --frozen-lockfile, bun run check, bun run typecheck, bun run test, bun run test:integration, bun run build, bun x vitest run src/lib/moderation-contract.test.ts src/lib/moderation-functions.test.ts, bun x vitest run src/lib/publish-runtime.test.ts src/lib/moderation-functions.test.ts, bun x vitest run src/components/studio/publish-studio.test.tsx, RUN_DB_INTEGRATION_TESTS=true bun x vitest run src/lib/server/publish-db.integration.test.ts -t 'inherited restrictions', Live browser + actual HTTP/PostgreSQL QA at 1c340de; scenarios S1-S7, R1-R8, six policy/help routes desktop/mobile
- PRs: