---
satisfies: [R4, R5, R6]
---
# fn-94-retrieval-proven-setup-and-connector.4 Lock activation parity privacy and documentation

## Description
Deliver the remaining cross-surface parity, privacy, evaluation, and documentation lock for the activation contract already shipped by fn-94.1 through fn-94.3. This task validates and explains the existing behavior; it must not recreate the activation status model, fingerprint path, or connector projection.

**Size:** M
**Files:** `test/core/activation-verifier.test.ts`, `test/core/connector-verifier.test.ts`, `test/store/activation-receipts.test.ts`, `test/store/migrations.test.ts`, `test/spec/schemas/activation-verification.test.ts`, `test/cli/doctor.test.ts`, `test/cli/status.test.ts`, `test/serve/api-status.test.ts`, `test/serve/public/components/BootstrapStatus.test.tsx`, `test/serve/public/components/FirstRunWizard.test.tsx`, `test/serve/public/components/HealthCenter.test.tsx`, `spec/db/schema.sql`, `spec/cli.md`, `spec/output-schemas/status.schema.json`, `spec/output-schemas/doctor.schema.json`, `docs/QUICKSTART.md`, `docs/INSTALLATION.md`, `docs/TROUBLESHOOTING.md`, `docs/CLI.md`, `docs/API.md`, `docs/MCP.md`, `assets/skill/SKILL.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Authoritative fn-94.3 contract to lock
- Migration 013 adds `documents.fts_mirror_hash` as an owned-writer synchronization marker. Every supported FTS writer clears/sets it transactionally. Migration from legacy databases performs a one-time body-equality check before backfilling the marker; passive reads never compare or select Markdown/FTS bodies.
- `StorePort.getActivationIndexSnapshot(collection)` is the only passive identity path. Its content-free snapshot combines active URI/source/mirror metadata, schema/tokenizer identity, and owned FTS row/marker state. Missing or stale owned FTS state returns `index_out_of_sync` before any lexical probe.
- A cold proof scans at most 64 document prefixes, each at most 32,768 characters, and attempts at most 64 corpus-derived terms. Warm exact-fingerprint deterministic negatives (`no_documents`, `no_probe_term`, `index_out_of_sync`) reuse their receipts without repeating corpus reads. Recoverable/transient `index_query_failed` and `retrieval_mismatch` outcomes retry under the same fingerprint; recoverable connector failures likewise remain retryable rather than becoming permanent cache hits.
- `ActivationStatus.connectorProjection` is authoritative: `total` counts all target/collection pairs, `projected` is the bounded persisted projection, and `truncated` means omitted pairs have no result. Truncation must remain incomplete/warn/non-passed across CLI, doctor, REST, and Web. UI copy/counts distinguish the rendered display cap from projected pairs and unprojected pairs.
- Semantic capability is tri-state. Omitted/unknown `vectorAvailable` maps to `semantic_not_checked`; only an explicitly known `false` maps to `vector_unavailable`. Capability presence alone never claims semantic proof passed.
- One shared status model owns CLI/doctor/REST/Web aggregation. `/api/health` remains process liveness. `gno status` exits 0 while exposing structured unhealthy state. `gno doctor` preserves its lexical activation exit rule; connector projection truncation is a warning and makes the doctor result non-healthy without inventing results for omitted pairs.

### Approach
- Consolidate the fn-94.1 core/store/schema fixtures with fn-94.2 connector and fn-94.3 core/CLI/REST/UI fixtures into one parity matrix. Do not duplicate already-covered lexical cases; add only missing cross-surface, connector retry, semantic tri-state, projection truncation, aggregation, privacy, performance, and exit-code assertions.
- Lock the published `ActivationVerificationReceipt@1.0` contract: four stages, all statuses/codes, strict ready/stage/evidence invariants, RFC 3339 dates, 16 KiB bound, target-specific receipt keys, deterministic-negative versus recoverable-failure cache policy, and invalidation after document, schema/tokenizer, or owned FTS-state changes.
- Prove privacy and bounded work at both SQLite and surface boundaries: passive identity is metadata-only; cold proof respects the 64 x 32,768-character and 64-term caps; no raw probe term/query/snippet/passage or unrestricted connector output is persisted; no corpus content reaches a remote provider. Passive status/doctor/Web/API paths must not call active connector verification, spawn children, initialize/download models, or invoke remote inference.
- Lock connector projection semantics and surface parity: bounded receipt loads only, explicit `total`/`projected`/`truncated`, no claim for omitted pairs, rendered-versus-projected-versus-unprojected counts, and no green connector health when projection is truncated.
- Lock semantic tri-state and exit/health parity in schema, CLI, REST, and component fixtures. Keep lexical usability, semantic pending, connector completeness, liveness, doctor health, and process exit behavior distinct.
- Document the exact integrity boundary: supported GNO writers maintain `fts_mirror_hash`; the migration validates legacy bodies once; direct out-of-band FTS body mutation after migration is not detectable by the metadata-only passive fingerprint and is outside the owned-writer contract. Do not turn that caveat into a public guarantee.
- Update repo docs, schemas, skill assets, and canonical hosted `gno.sh` install/troubleshooting language. Run docs sync/verification, package smoke, affected retrieval evals, and the GNO skill autoresearch workflow. Copy/reinstall a changed skill only if the current asset no longer scores 100%.

### Remaining ownership
This task owns comprehensive parity/privacy fixtures, evaluation locks, user-facing documentation, hosted `gno.sh` propagation, package smoke, and skill autoresearch. It should only change shipped activation implementation when a new failing contract test exposes a real gap; otherwise consume the fn-94.3 APIs and behavior as authoritative.

### Investigation targets
**Required** (read before coding):
- `src/core/activation-status.ts`
- `src/core/activation-verifier.ts`
- `src/core/activation-probe-plan.ts`
- `src/store/types.ts`
- `src/store/sqlite/adapter.ts`
- `src/store/migrations/013-fts-sync-marker.ts`
- `test/core/activation-verifier.test.ts`
- `test/core/activation-status.test.ts`
- `test/store/activation-receipts.test.ts`
- `test/store/migrations.test.ts`
- `test/cli/doctor.test.ts`
- `test/cli/status.test.ts`
- `test/serve/api-status.test.ts`
- `test/serve/public/components/BootstrapStatus.test.tsx`
- `docs/QUICKSTART.md`
- `docs/INSTALLATION.md`
- `spec/cli.md`
- `spec/db/schema.sql`
- `assets/skill/SKILL.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

**Optional** (reference as needed):
- `docs/MCP.md`
- `docs/API.md`
- `src/serve/activation-health.ts`
- `src/cli/commands/doctor-activation.ts`
## Acceptance
- [ ] Schema and parity fixtures cover every activation stage/status/failure code plus exact-fingerprint deterministic-negative reuse and recoverable lexical/connector retry behavior.
- [ ] Store/migration tests lock migration 013's one-time legacy body validation, owned-writer `fts_mirror_hash` maintenance, metadata-only `getActivationIndexSnapshot`, fail-before-probe `index_out_of_sync`, fingerprint invalidation, and the documented out-of-band mutation caveat.
- [ ] Privacy/performance tests prove passive checks select no corpus/FTS bodies, cold proof stays within 64 document prefixes x 32,768 characters and 64 terms, activation sends no corpus content to remote providers, and receipts store no probe term or passage text.
- [ ] CLI, doctor, REST, and Web fixtures agree on lexical usability/health, semantic tri-state (`semantic_not_checked` for unknown; `vector_unavailable` only for explicit false), connector `total`/`projected`/`truncated`, omitted=no-claim behavior, rendered/projected/unprojected counts, and liveness/health/exit semantics.
- [ ] Passive status/doctor/Web/API paths never spawn connector children, call active connector verification, initialize/download models, invoke remote inference, or perform unbounded receipt/index work; projection truncation remains warn/non-passed rather than green.
- [ ] Repo docs, schemas, UI language, skill assets, and canonical hosted `gno.sh` guidance accurately describe lexical proof, semantic pending, MCP-versus-skill verification, metadata-only passive identity, bounded cold work, projection omission, migration integrity boundaries, and remediation without overstating unsupported FTS tamper detection.
- [ ] Full gates include lint/typecheck/format, `bun test`, affected retrieval evals, docs sync/verification, package smoke, hosted-doc verification, and the skill autoresearch check required by changed CLI/MCP behavior.
## Done summary
Locked the retrieval-proven activation contract across runtime validation, JSON schemas, CLI, doctor, REST, Web, package smoke, and documentation. Receipts now enforce stage-specific codes, timing, evidence, exact lexical readiness, connector-versus-lexical coherence, RFC 3339 timestamps, a 16 KiB ceiling, and metadata-only fingerprint invalidation for schema, tokenizer, documents, and owned FTS synchronization state.

Closed the remaining surface gaps: connector projection truncation and observed failures cannot render green; semantic capability remains tri-state; doctor holds the store open through activation proof and preserves lexical exit semantics; onboarding does not claim semantic readiness from cached models alone. Added an explicit CSRF-protected, read-only Web/API MCP verification action with strict request validation, bounded redacted output, separate `lexicalReady` and `connectorReady`, and honest `target_runtime_unverifiable` behavior for skills.

Documented the owned-writer integrity boundary and exact remediation across repo docs/specs and the hosted gno.sh guidance. Package smoke now proves a packed install can update, return lexical-ready status, keep semantic work pending, and pass doctor. The shipped skill scored 48/48 (100%) in an isolated autoresearch baseline, so no skill change or reinstall was needed. Independent inherited-model review found and verified fixes for connector false-green API naming, missing cross-stage receipt invariants, and doctor exit wording; final verdict CLEAN / SHIP.
## Evidence
- Commits: 6ad97e1, a8641a5e1bdb32b0a78b6c3775032b885cd74a1c
- Tests: bun run lint:check (green: 0 warnings/errors; formatting clean), bun run typecheck (green), focused activation parity suite (193 pass, 0 fail before review; 28 pass, 0 fail after review fixes), bun test (2157 pass, 1 Windows-only skip, 0 fail; 244 files), bun run prerelease (green after review fixes), bun run docs:verify (12 pass, 0 fail, 2 expected model-cache skips), make -C website sync-docs (green), bun run eval:hybrid (88%, threshold 70%), bun run build:css && bun run test:package (green; packed @gmickel/gno 1.12.4 activation smoke), isolated shipped-skill autoresearch baseline (48/48, 100%), gno.sh: bun run check; bun run typecheck; bun test (76 pass, 5 integration skips); bun run build (67 pages), .flow/bin/flowctl validate --spec fn-94-retrieval-proven-setup-and-connector --json (valid)
- PRs: