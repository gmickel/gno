---
satisfies: [R1, R2, R4, R5]
---
# fn-94-retrieval-proven-setup-and-connector.3 Integrate activation into CLI REST and onboarding health

## Description
Deliver integrate activation into cli rest and onboarding health as one implementation-sized increment.

**Size:** M
**Files:** `src/core/activation-status.ts`, `src/cli/program.ts`, `src/cli/commands/doctor.ts`, `src/cli/commands/status.ts`, `src/serve/status-model.ts`, `src/serve/routes/api.ts`, `src/serve/status.ts`, `src/serve/public/components/BootstrapStatus.tsx`, `src/serve/public/components/FirstRunWizard.tsx`, `src/serve/public/components/HealthCenter.tsx`, `src/store/types.ts` (only if bounded passive receipt listing is needed), `spec/cli.md`, `spec/output-schemas/status.schema.json`, `spec/output-schemas/doctor.schema.json`, `test/core/activation-status.test.ts`, `test/cli/doctor.test.ts`, `test/cli/status.test.ts`, `test/serve/api-status.test.ts`, `test/serve/public/components/BootstrapStatus.test.tsx`, `test/serve/public/components/FirstRunWizard.test.tsx`, `test/serve/public/components/HealthCenter.test.tsx`, `test/spec/schemas/status.test.ts`, `test/spec/schemas/doctor.test.ts`

### Approach
- Add one shared activation status aggregator over the per-collection `ActivationVerificationReceipt@1.0` rows and optional target-specific connector rows; CLI, REST, and Web must consume that model without reimplementing probe or readiness logic.
- Run `verifyLexicalActivation` for every configured collection and retain every receipt in deterministic collection order. Expose two unambiguous aggregates: `usable` means at least one collection has a passing lexical receipt; `healthy` means at least one collection is configured and every configured collection receipt is ready. UI green and `gno doctor` success use `healthy`; `usable:true, healthy:false` is a visibly degraded state, never green. Empty/unsupported collections remain explicit failures/remediation.
- Keep `/api/health` as process liveness. Expose readiness additively under `/api/status.activation`; mirror the same contract in `gno status` and `gno doctor`. `gno status` still exits successfully while emitting `healthy:false`; `gno doctor` exits 2 when lexical activation is not ready.
- Show the exact failed/pending stage, stable code, collection/connector target, and next command. Connector failure does not rewrite the receipt's lexical `ready` invariant; render connector health separately so a requested broken target cannot look green.
- Passive `status`/`doctor`/Web/API paths must never call `verifyConnectorActivation` or `verifyInstalledConnector`, spawn a connector child, initialize/download models, or make a remote call. If connector receipts are projected on these passive surfaces, add a bounded StorePort receipt load/list operation and consume persisted, fingerprint-valid rows only; do not turn passive rendering into runtime verification.
- Keep semantic activation `pending` in this feature with a stable reason such as `models_missing`, `embeddings_pending`, or `vector_unavailable`; never report semantic `passed`. Semantic pending is independent of, and does not block, lexical usability.
- Reuse only fingerprint-matched receipts, rely on fn-94.1 FTS-state invalidation, and coalesce concurrent verification for the same collection/fingerprint/target. A failed or corrupt cached row must never become a stale green response.
- Preserve status latency: avoid per-request indexing/model work and unbounded receipt scans; add a regression/performance safeguard proving cached/passive status stays within the existing status budget on a multi-collection fixture.

### Shipped contracts to preserve
- The receipt is per collection, not a singleton. SQLite migration 012 keys it by `(collection, connector_target)`.
- `ready === (index.status === "passed" && lexical.status === "passed")`; ready receipts require `probeHash`, `resultUri`, and `resultSourceHash`.
- The fingerprint includes schema, tokenizer, active document hashes, and FTS synchronization state; surfaces must not add an independent TTL cache that bypasses it.
- Connector stage and semantic stage are truthful partial states, not prerequisites for immediate lexical use.
- Connector remediation comes from fn-94.2's deterministic code/target mapper; it is not arbitrary persisted receipt text.
- Use the shipped fn-94.2 contracts rather than recreating connector policy: `verifyConnectorActivation` and `ConnectorVerificationTarget` (`McpConnectorVerificationTarget` / `SkillConnectorVerificationTarget`) from `src/core/connector-verifier.ts`, `verifyInstalledConnector` from `src/serve/connectors.ts` only on explicit active verification paths, and `getConnectorVerificationRemediation` for deterministic presentation.
- Existing `gno status` and `gno doctor` fields remain backward-compatible; activation is additive in human and JSON output. Wire exit semantics at `src/cli/program.ts`: `gno status` exits 0 even when activation is unhealthy, while `gno doctor` exits 2 when lexical activation is unhealthy.

### Investigation targets
**Required** (read before coding):
- `src/cli/commands/doctor.ts`
- `src/cli/program.ts`
- `src/serve/routes/api.ts:732-780`
- `src/serve/status.ts`
- `src/serve/status-model.ts`
- `src/serve/public/components/BootstrapStatus.tsx`

**Optional** (reference as needed):
- `src/serve/public/components/HealthCenter.tsx`
- `src/serve/public/components/FirstRunWizard.tsx`
- `src/core/activation-verifier.ts`
- `src/store/types.ts`
- `spec/cli.md`
- `spec/output-schemas/status.schema.json`
- `spec/output-schemas/doctor.schema.json`

## Acceptance
- [ ] CLI, REST, and Web render the same stage statuses and remediation from one contract.
- [ ] A failed lexical stage cannot appear green on any surface.
- [ ] Semantic pending does not block lexical usability and is visibly distinguished from failure.
- [ ] Status/API paths perform no model download or remote call, `/api/health` remains liveness-only, and concurrent checks coalesce without reusing fingerprint-stale receipts.
- [ ] Passive status/doctor/Web/API tests prove they never invoke connector verification or spawn a child; any connector projection reads only bounded, fingerprint-valid persisted receipts.
- [ ] Multi-collection core and UI component fixtures prove deterministic `usable`/`healthy` aggregation, explicit empty/unsupported handling, visibly degraded mixed outcomes, semantic-pending/lexical-usable presentation, additive status compatibility, `status` exit 0 versus lexical-unhealthy `doctor` exit 2, and separate connector health.
- [ ] Status performance safeguards reject unbounded receipt/model/index work and keep passive cached status within the existing latency budget.
- [ ] `spec/cli.md`, status/doctor JSON schemas, and contract tests change before or with implementation; task .3 lands with no contract/docs drift deferred to .4.


## Done summary
Integrated retrieval-proven activation across CLI, REST, doctor, and Web, then resolved the independent review findings. Passive fingerprints now use metadata plus an owned FTS synchronization marker without selecting or comparing Markdown/FTS bodies. Cold probes read at most 64 prefixes of 32,768 characters; stale or missing FTS state fails closed before probing. Failed lexical and connector receipts retry under an unchanged fingerprint so repaired/transient failures recover.

Connector projection truncation now forces degraded/warn health everywhere and distinguishes rendered, projected, and omitted counts. CLI green labels are explicitly lexical. Passive semantic availability is tri-state: unknown remains semantic_not_checked, while vector_unavailable requires a known false runtime capability. Migration 013, schema snapshot, owned-writer coverage, recovery, stale-shared-term, bounded-read, surface, and component regressions are included.

Inherited-model read-only review found one final CLI wording ambiguity under projection truncation; it was fixed and the focused gate rerun green.
## Evidence
- Commits: 96736bc, 7bd3f29
- Tests: bun run lint:check (green), bun run typecheck (green), focused activation/CLI/serve/store suite (66 pass, 0 fail before final review; 62 pass, 0 fail after review wording fix), bun test (2125 pass, 1 Windows-only skip, 0 fail; 11169 assertions; 240 files; 39.90s), bun run docs:verify (12 pass, 0 fail, 2 expected model-cache skips), bun run eval:hybrid (88%, threshold 70%), .flow/bin/flowctl validate --all (110 specs, 312 tasks, valid)
- PRs: