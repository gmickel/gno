---
satisfies: [R2, R3, R6]
---
# fn-105-verified-folder-setup.3 Integrate connector verification onboarding and optional profiles

## Description
Integrate explicit connector verification into the verified-setup CLI summary and Web/Desktop onboarding by composing the closed folder-setup transaction with activation APIs already shipped by fn-94. Do not create a setup-specific fingerprint, receipt, projection, health, or connector-target model.

**Size:** M
**Files:** `src/cli/commands/setup.ts`, `src/core/activation-connector-health.ts`, `src/serve/connectors.ts`, `src/serve/routes/api.ts`, `src/serve/status-model.ts`, `src/serve/public/components/FirstRunWizard.tsx`, `src/serve/public/pages/Connectors.tsx`, `test/setup/setup-integration.test.ts`, `test/serve/api-status.test.ts`, `test/serve/api-connectors.test.ts`, `test/serve/public/components/FirstRunWizard.test.tsx`, `test/serve/public/connectors-page.test.tsx`

### Approach
- Treat `FolderSetupReceipt@1.0` from fn-105.1 as a closed lexical transaction with six frozen stages and a single lexical `activation` field. Do not append connector stages/identities, change its schema/path/serializer, or reopen `src/core/folder-setup.ts`. After `setupFolder` succeeds, caller-owned CLI/onboarding composition may present separate shipped connector activation receipts and generic pending/remediation state. <!-- Updated by plan-sync: fn-105.1 landed a closed lexical setup receipt; connector verification composes beside it rather than mutating it. -->
- Reuse `verifyLexicalActivation` for retrieval proof and `buildActivationStatus` for passive aggregation/presentation. The verifier already consumes `StorePort.getActivationIndexSnapshot`, migration 013's owned-writer `documents.fts_mirror_hash` marker, metadata-only passive fingerprints, `index_out_of_sync` fail-before-probe behavior, and cold bounds of 64 document prefixes x 32,768 characters with at most 64 terms. Setup must not query/compare bodies for identity, maintain a second FTS marker, or reimplement these bounds.
- Preserve exact-fingerprint cache policy: deterministic negatives (`no_documents`, `no_probe_term`, `index_out_of_sync`) may be reused; recoverable `index_query_failed` and `retrieval_mismatch` outcomes retry. Setup must not add a TTL/cache layer that changes this behavior.
- Compose target-specific connector receipts only after the returned folder-setup receipt is `completed` and its lexical activation proof passed, and only when verification was explicitly requested. Use `getConnectorVerificationTargets`, `verifyInstalledConnector`/`verifyConnectorActivation`, the shipped `ConnectorVerificationTarget` types, and `getConnectorVerificationRemediation`. Supported local MCP targets run the bounded read-only smoke; skill targets without a safe runtime hook return `skipped/target_runtime_unverifiable`. Recoverable connector failures remain retryable and optional connector failure must not be relabeled as lexical setup failure.
- Reuse the shipped explicit Web/API action: `POST /api/connectors/verify` accepts exactly `{ connectorId, collection }`, is CSRF/origin protected, and returns a bounded redacted projection with separate `lexicalReady` and `connectorReady` booleans plus only the connector stage and deterministic remediation. Populate its collection selector from `GET /api/connectors`; do not expose setup-receipt paths, receipt fingerprints, probe/source hashes, result URIs, or connector target identities. <!-- Updated by plan-sync (cross-spec): fn-94.4 shipped the explicit connector verification route and split readiness projection -->
- Preserve `ActivationVerificationReceipt@1.0` cross-stage invariants: `ready` remains index-plus-lexical readiness only; a passed connector proof and probe-time connector failures require lexical proof, while pre-probe unsupported/unavailable states keep their shipped failed/skipped semantics. Never serialize connector success beside a lexical-failed setup result. <!-- Updated by plan-sync (cross-spec): fn-94.4 locked connector-versus-lexical receipt validation -->
- Use the shipped passive connector projection unchanged. `connectorProjection.total` counts all target/collection pairs, `projected` is the bounded persisted subset, and `truncated` means omitted pairs have no result. Passive onboarding/status must never actively verify or spawn a child; UI counts and copy distinguish rendered targets, projected-but-not-rendered targets, and unprojected targets, and truncation never appears green.
- Use `isConnectorActivationComplete` for connector completeness instead of reimplementing health rules: truncation is incomplete, observed non-passing proofs are incomplete, and `connector_not_configured`/`target_runtime_unverifiable` remain non-runtime no-claim states. Await every setup-owned activation/status aggregation before closing its store, matching fn-94.4's doctor lifecycle fix. <!-- Updated by plan-sync (cross-spec): fn-94.4 shipped shared connector health parity and fixed doctor store lifetime -->
- Preserve semantic tri-state: unknown/omitted `vectorAvailable` remains `semantic_not_checked`; only an explicitly known false capability becomes `vector_unavailable`; neither state blocks lexical usability or claims semantic proof passed.
- Preserve cross-surface contracts: `/api/health` stays liveness-only; activation remains additive to status; `gno status` retains exit 0 for inspectable unhealthy state; `gno doctor` retains its lexical activation exit rule while connector truncation remains a warning/non-healthy result. Reuse the resident status/onboarding model rather than adding setup-only health logic.
- Treat FTS integrity as the shipped owned-writer contract. Migration 013 validates legacy FTS bodies once before marker backfill; direct out-of-band FTS body mutation after migration is outside metadata-only passive detection. Do not overstate that boundary in onboarding or setup success language.
- Add a narrow optional profile-discovery hook that can consume fn-107 once present; setup remains fully functional without `.gno/index.yml`.

### Investigation targets
**Required** (read before coding):
- `src/core/folder-setup.ts`
- `src/core/setup-receipt.ts`
- `spec/output-schemas/setup-receipt.schema.json`
- `src/cli/commands/setup.ts`
- `src/core/activation-status.ts`
- `src/core/activation-verifier.ts`
- `src/store/types.ts`
- `src/serve/connectors.ts`
- `src/serve/routes/api.ts`
- `src/serve/status-model.ts`
- `src/serve/public/components/FirstRunWizard.tsx`
- `src/serve/public/components/BootstrapStatus.tsx`
- `test/core/activation-status.test.ts`
- `test/setup/setup-integration.test.ts`
- `test/serve/api-status.test.ts`

**Planned dependency output:**
- `src/core/project-profile.ts` from fn-107, optional and not required for basic setup.

### Key context
- fn-94.4 is authoritative for activation identity, bounded lexical proof, receipt invariants, cache/retry policy, aggregation, passive receipt projection, explicit Web/API connector verification, semantic tri-state, UI state, liveness, exit compatibility, and status latency. Consume those APIs; do not fork them. <!-- Updated by plan-sync (cross-spec): fn-94.4 finalized the activation contract -->
- fn-105.1 is authoritative for folder safety, collection create/reuse, config/store convergence, lexical ingestion/proof, and the closed setup receipt. Consume `setupFolder`; do not repeat or extend its transaction.
- “Supported connector” means an execution-capable fn-94 target: a safe local MCP config today or a future skill client with a read-only runtime hook. Installed skill files alone are presence evidence, not runtime proof.
- This task owns explicit connector-verification timing, setup-result composition, onboarding handoff, and optional profile composition. Comprehensive activation parity/privacy/docs/eval locks and hosted `gno.sh` updates remain in fn-94.4/fn-105.4.
## Acceptance
- [ ] Requested supported local MCP verification runs only after a completed/passed `setupFolder` result, uses the shipped fn-94 target/verifier/remediation APIs, and completes a real read-only check or returns explicit pending/failed remediation; unverifiable skill runtimes return `skipped/target_runtime_unverifiable` and are never reported as executed.
- [ ] The closed `FolderSetupReceipt@1.0` schema, path, serializer, six stages, and lexical activation field remain unchanged; connector receipts are composed separately and no connector identity is persisted in the setup receipt.
- [ ] Web onboarding reuses the CSRF-protected `POST /api/connectors/verify` action and `GET /api/connectors` collection projection; its bounded response keeps `lexicalReady` separate from `connectorReady` and leaks no setup-receipt path, receipt fingerprint, probe/source hash, result URI, or target identity.
- [ ] Setup composition reuses `setupFolder`, `verifyLexicalActivation`, `buildActivationStatus`, and the existing StorePort activation contract; it adds no parallel preflight, indexing, fingerprint, FTS marker/body comparison, receipt cache, projection, or health model.
- [ ] Connector receipts preserve the shipped connector-versus-lexical stage invariants, and connector completeness is derived through `isConnectorActivationComplete`; projection truncation and observed non-pass states cannot become green.
- [ ] CLI/Web/Desktop present the setup receipt and shipped activation receipts without merging their schemas, while preserving deterministic-negative reuse, recoverable lexical/connector retry, `index_out_of_sync` fail-before-probe, and the 64 x 32,768-character/64-term cold bound.
- [ ] Passive onboarding/status never invokes active connector verification, spawns children, initializes models, performs remote inference, or scans unbounded receipts/content. Projection truncation distinguishes rendered/projected/unprojected counts, makes no claim for omitted pairs, and never appears green.
- [ ] Semantic unknown stays `semantic_not_checked`, explicit false maps to `vector_unavailable`, semantic pending remains independent of lexical usability, `/api/health` stays liveness-only, and existing status/doctor health and exit behavior remain unchanged.
- [ ] Setup/onboarding language stays within the owned-writer FTS integrity boundary and does not claim detection of direct out-of-band post-migration FTS body mutation.
- [ ] Absence, invalidity, or future presence of a project profile never makes basic setup ambiguous or destructive.
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
