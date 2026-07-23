---
satisfies: [R2, R4, R5, R6, R7]
---
# fn-102-knowledge-delta-and-capsule.5 Complete delta schemas lifecycle tests and documentation

## Description
Close fn-102 against the implementation that actually landed in tasks 1–4:
freeze every Knowledge Delta and saved-Capsule output contract, prove the
resident lifecycle/security/privacy boundaries, reconcile all public
documentation, and leave the repository and hosted site on a genuinely green
release gate.

**Size:** M
**Files:** `spec/output-schemas`, `spec/cli.md`, `spec/mcp.md`, `spec/db/schema.sql`, `test/spec/schemas`, `test/changes`, `test/serve`, `test/cli`, `test/store`, `docs/CLI.md`, `docs/API.md`, `docs/MCP.md`, `docs/DAEMON.md`, `docs/WEB-UI.md`, `docs/TROUBLESHOOTING.md`, `README.md`, `website/_config.yml`, `assets/skill/SKILL.md`, `scripts/package-smoke-model.ts`, `~/work/gno.sh`

### Approach
- Freeze the task-3 read contracts for CLI/REST/MCP/SDK
  `changes`/`diff`/`impact`, including opaque cursors, retention boundaries,
  partial history, truncation, bounded impact paths, and cross-surface
  equivalence. Add the missing Draft-07 schemas and fixtures rather than
  allowing implementation-shaped JSON to remain an implicit contract.
- Freeze the task-4 CLI and local-event contracts that actually shipped:
  `gno context watch <file>`, `watches`, `unwatch <registration>`, and
  `reverify <registration>`, plus metadata-only `capsule-reverified` SSE
  events. Registration outputs may expose the explicit absolute file path,
  exact file hash, Capsule/index identity, optional question/label,
  notification preference, journal sequence, evidence URI/hash references,
  and latest verification metadata. They must never expose or persist Capsule
  bytes or evidence passage text. Notification schemas are stricter:
  registration/Capsule identity, operation status, affected-question state,
  and timestamp only—no question, label, path, URI, hashes, receipt, or source
  content.
- Test migration 016 and the metadata-only tables
  `saved_capsule_registrations`, `saved_capsule_evidence`,
  `saved_capsule_verifications`, and
  `saved_capsule_reverification_state`, including fresh install, upgrade,
  cascade deletion, uniqueness/bounds, canonical latest-receipt persistence,
  and the XOR between a completed canonical receipt and a failed operation
  record.
- Complete lifecycle coverage around
  `SavedCapsuleReverificationScheduler`: raw journal evidence matching,
  settled-sync coalescing, one bounded serial drain, durable high-water restart
  behavior, cancellation/shutdown, cursor-expiry fallback, unrelated changes,
  retry/manual recovery after operation failures, multiple Capsules, and
  resident `serve`/`daemon` integration. Prove local notification emission
  happens only after commit.
- Extend freshness fixtures across unchanged/stale/missing/corrupt
  source/mirror/passage/chunk states, current hashes, ranking unchanged/
  reranked/unavailable, aggregate fingerprint drift with ordered distinct
  reasons, and affected-question state. Include a saved Capsule large enough
  to cross SQLite lookup batching and canonical saved/runtime index mismatch
  rejection before evidence-store reads. Keep file bytes immutable for
  success, missing-file, invalid-file, and exact-hash-change paths.
- Preserve the non-generative boundary: reverification calls only
  `verifyContextCapsuleRuntime`, stores
  `canonicalVerifiedContextCapsuleJson`, and never invokes verified Ask,
  answer generation, or fn-101 promotion/evaluation artifacts.
- Reconcile repo docs, legacy website sources, generated docs, the installed
  skill, and `~/work/gno.sh`. Explain journal limits, cursor expiry, exact
  commands, per-index registration scope, resident scheduling, local-only
  metadata notifications, privacy, immutable user files, canonical receipt
  versus operation failure, and no autonomous synthesis. Run the skill
  autoresearch workflow because CLI behavior changed.
- Make final gates genuinely green. Fix the inherited package-smoke TypeScript
  failure in `scripts/package-smoke-model.ts` where `ReadableStream` lacks the
  async-iterator type in the package-check environment. Reconcile the current
  package version `1.20.0` with stale `1.19.0` strings in `README.md` and
  `website/_config.yml`, then run public-truth/docs verification. Run package,
  schema, lifecycle, security, lint, type, docs, and full test gates. Do not
  wait on macOS/Windows client artifact builds; those are checked once the
  complete program is landed.

### Investigation targets
**Required** (read before coding):
- `src/core/capsule-registry.ts`
- `src/core/capsule-reverification.ts`
- `src/core/capsule-reverification-scheduler.ts`
- `src/store/migrations/016-saved-capsules.ts`
- `src/store/sqlite/capsule-registry-store.ts`
- `src/cli/commands/context-saved.ts`
- `src/serve/resident-runtime.ts`
- `src/serve/doc-events.ts`
- `scripts/package-smoke-model.ts`
- `test/spec/schemas`
- `docs/CLI.md`
- `docs/DAEMON.md`
- `assets/skill/SKILL.md`

**Optional** (reference as needed):
- `test/changes/capsule-reverification.test.ts`
- `test/changes/cross-surface.test.ts`
- `test/changes/knowledge-delta.test.ts`
- `test/store/change-journal.test.ts`
- `docs/API.md`
- `docs/MCP.md`
- `docs/WEB-UI.md`
- `docs/TROUBLESHOOTING.md`
- `README.md`
- `website/_config.yml`
- `~/work/gno.sh`
## Acceptance
- [ ] Draft-07 schemas and contract fixtures cover every
  change/diff/impact/watch/list/unwatch/reverify result and the closed
  metadata-only `capsule-reverified` event. Cross-surface parity holds where a
  surface exists; CLI-only saved-Capsule lifecycle output is documented as
  CLI-only rather than inventing REST/MCP/SDK endpoints.
- [ ] Verification schema tests cover `currentFingerprints`,
  `fingerprintStatus`, ordered distinct `fingerprintReasons`, every content
  classification/current-hash shape, ranking independence, affected-question
  state, and completed-receipt versus operation-failure exclusivity.
- [ ] Migration 016, registration limits/cascades, exact-file immutability,
  no-Capsule-byte persistence, and large-Capsule SQLite batching pass.
- [ ] Race/no-op/failure/retention/purge/cursor-expiry fixtures prove no false
  deltas, silent history fabrication, duplicate reverification after restart,
  or notification before persistence.
- [ ] Resident lifecycle tests prove settled watcher/full-sync scheduling,
  bounded/coalesced work, graceful cancellation/shutdown, canonical index
  authority before evidence reads, and no answer-generation call path.
- [ ] Security/privacy tests prove database registration rows contain no
  Capsule or passage bytes and local notification payloads contain no question,
  label, path, URI, hash, receipt, credential, or source content.
- [ ] Repo docs, generated/legacy website material, installed skill, and
  `~/work/gno.sh` explain exact capabilities, limits, privacy, index scope,
  canonical freshness receipts, disjoint failures, and non-autonomous behavior.
- [ ] `scripts/package-smoke-model.ts` typechecks in the package-smoke
  environment without weakening stream/runtime validation.
- [ ] Package `1.20.0`, `README.md`, and `website/_config.yml` agree;
  public-truth and `bun run docs:verify` are green.
- [ ] Focused schema/lifecycle/security suites, `bun run lint:check`, package
  typecheck/smoke, full `bun test`, docs verification, Flow validation,
  skill autoresearch, and hosted-site checks are green. macOS/Windows client
  artifact builds are explicitly deferred until all program specs land.
<!-- Updated by plan-sync (cross-spec): fn-102-knowledge-delta-and-capsule.4 shipped metadata-only registration, migration 016, CLI watch lifecycle, settled raw-journal scheduling, canonical freshness receipts, disjoint failures, and post-commit local SSE notifications; task 5 freezes and proves those actual contracts rather than inventing additional surfaces. -->
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.4 review fixes expanded the canonical reverification receipt and large-Capsule verification contract -->
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.5 review fixes established saved-Capsule index authority for lifecycle docs and tests -->
<!-- Updated by plan-sync (cross-spec): fn-101-trustworthy-synthesis-and-claim.4 froze answer-evaluation artifacts separately from saved-Capsule freshness receipts -->


## Done summary
Completed Knowledge Delta and saved Context Capsule hardening.

- Froze closed JSON Schema contracts for changes, diff, impact, the saved-Capsule lifecycle, reverification receipts, and local SSE events.
- Added migration, lifecycle, batching, scheduler, concurrency, cancellation, privacy, immutable-file, schema, CLI, and resident-runtime coverage.
- Reconciled CLI, API, MCP, daemon, Web UI, troubleshooting, README, changelog, DB spec, package version references, and the installed agent skill.
- Updated the hosted gno.sh product/docs truth on matching feature branch `feat/knowledge-delta`.
- Fixed package-smoke streaming for TypeScript's ReadableStream contract and verified the packed 1.20.0 tarball.
- Full tests, lint, typecheck, docs verification, Flow validation, focused acceptance tests, package smoke, canonical hybrid evaluation, gno.sh checks/build, and 48/48 skill autoresearch passed.
- Full Evalite retrieval lanes cleared threshold, but its duplicate auto-discovery of an existing nested worktree ran the generation-backed Ask suite twice and exhausted local VRAM; canonical hybrid rerun passed at 86% (88% combined duplicate discovery).
- macOS and Windows client artifact builds remain intentionally deferred per the program gate-time instruction.
## Evidence
- Commits: f91299d, a671101
- Tests: bun run lint:check, bun run typecheck, bun run docs:verify, /Users/gordon/.codex/scripts/flowctl validate --all, bun test (2833 pass, 1 expected Windows skip, 0 fail), bun test test/spec/schemas/knowledge-delta.test.ts test/spec/schemas/saved-capsule-lifecycle.test.ts test/cli/context-saved.test.ts test/serve/doc-events.test.ts test/serve/resident-runtime.test.ts test/store/migrations.test.ts test/changes/capsule-reverification.test.ts (25 pass, 0 fail), bun run test:package, bun run eval:hybrid (86% canonical, 88% aggregate, threshold 70%), autoresearch-gno-skill ./.venv/bin/python eval.py (48/48, 100.0), gno.sh: bun run check, gno.sh: bun run typecheck, gno.sh: bun test (84 pass, 5 expected integration skips, 0 fail), gno.sh: bun run build
- PRs: