---
satisfies: [R2, R3, R6]
---
# fn-105-verified-folder-setup.3 Integrate connector verification onboarding and optional profiles

## Description
Integrate explicit connector verification into verified folder setup and Web/Desktop onboarding by composing the activation APIs already shipped by fn-94. Do not create a setup-specific fingerprint, receipt, projection, health, or connector-target model.

**Size:** M
**Files:** `src/core/folder-setup.ts`, `src/serve/connectors.ts`, `src/serve/routes/api.ts`, `src/serve/status-model.ts`, `src/serve/public/components/FirstRunWizard.tsx`, `test/setup/setup-integration.test.ts`, `test/serve/api-status.test.ts`, `test/serve/public/components/FirstRunWizard.test.tsx`

### Approach
- Reuse `verifyLexicalActivation` for retrieval proof and `buildActivationStatus` for passive aggregation/presentation. The verifier already consumes `StorePort.getActivationIndexSnapshot`, migration 013's owned-writer `documents.fts_mirror_hash` marker, metadata-only passive fingerprints, `index_out_of_sync` fail-before-probe behavior, and cold bounds of 64 document prefixes x 32,768 characters with at most 64 terms. Setup must not query/compare bodies for identity, maintain a second FTS marker, or reimplement these bounds.
- Preserve exact-fingerprint cache policy: deterministic negatives (`no_documents`, `no_probe_term`, `index_out_of_sync`) may be reused; recoverable `index_query_failed` and `retrieval_mismatch` outcomes retry. Setup must not add a TTL/cache layer that changes this behavior.
- Compose target-specific connector receipts only after lexical proof when verification was explicitly requested. Use `getConnectorVerificationTargets`, `verifyInstalledConnector`/`verifyConnectorActivation`, the shipped `ConnectorVerificationTarget` types, and `getConnectorVerificationRemediation`. Supported local MCP targets run the bounded read-only smoke; skill targets without a safe runtime hook return `skipped/target_runtime_unverifiable`. Recoverable connector failures remain retryable and optional connector failure must not be relabeled as lexical setup failure.
- Use the shipped passive connector projection unchanged. `connectorProjection.total` counts all target/collection pairs, `projected` is the bounded persisted subset, and `truncated` means omitted pairs have no result. Passive onboarding/status must never actively verify or spawn a child; UI counts and copy distinguish rendered targets, projected-but-not-rendered targets, and unprojected targets, and truncation never appears green.
- Preserve semantic tri-state: unknown/omitted `vectorAvailable` remains `semantic_not_checked`; only an explicitly known false capability becomes `vector_unavailable`; neither state blocks lexical usability or claims semantic proof passed.
- Preserve cross-surface contracts: `/api/health` stays liveness-only; activation remains additive to status; `gno status` retains exit 0 for inspectable unhealthy state; `gno doctor` retains its lexical activation exit rule while connector truncation remains a warning/non-healthy result. Reuse the resident status/onboarding model rather than adding setup-only health logic.
- Treat FTS integrity as the shipped owned-writer contract. Migration 013 validates legacy FTS bodies once before marker backfill; direct out-of-band FTS body mutation after migration is outside metadata-only passive detection. Do not overstate that boundary in onboarding or setup success language.
- Add a narrow optional profile-discovery hook that can consume fn-107 once present; setup remains fully functional without `.gno/index.yml`.

### Investigation targets
**Required** (read before coding):
- `src/core/folder-setup.ts`
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
- fn-94.3 is authoritative for activation identity, bounded lexical proof, cache/retry policy, aggregation, passive receipt projection, semantic tri-state, UI state, liveness, exit compatibility, and status latency. Consume those APIs; do not fork them.
- “Supported connector” means an execution-capable fn-94 target: a safe local MCP config today or a future skill client with a read-only runtime hook. Installed skill files alone are presence evidence, not runtime proof.
- This task owns setup orchestration, explicit connector-verification timing, onboarding handoff, and optional profile composition. Comprehensive activation parity/privacy/docs/eval locks and hosted `gno.sh` updates remain in fn-94.4.
## Acceptance
- [ ] Requested supported local MCP verification uses the shipped fn-94 target/verifier/remediation APIs and completes a real read-only check or returns explicit pending/failed remediation; unverifiable skill runtimes return `skipped/target_runtime_unverifiable` and are never reported as executed.
- [ ] Setup reuses `verifyLexicalActivation`, `buildActivationStatus`, and the existing StorePort activation contract; it adds no parallel fingerprint, FTS marker/body comparison, receipt cache, projection, or health model.
- [ ] CLI/Web/Desktop expose the same persisted setup and activation receipts while preserving deterministic-negative reuse, recoverable lexical/connector retry, `index_out_of_sync` fail-before-probe, and the 64 x 32,768-character/64-term cold bound.
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
