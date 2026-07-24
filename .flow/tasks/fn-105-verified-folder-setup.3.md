---
satisfies: [R2, R3, R6]
---
# fn-105-verified-folder-setup.3 Integrate connector verification onboarding and optional profiles

## Description
Integrate opt-in connector installation and verification with the already-closed standalone folder setup result. Reuse the activation and connector APIs shipped by fn-94; do not create a setup-specific fingerprint, receipt, projection, health model, connector target, or resident path.

**Size:** M
**Files:** `src/cli/commands/setup.ts`, `src/cli/program.ts`, `src/serve/connectors.ts`, `src/core/setup-activation.ts` (new composition only), `spec/cli.md`, `spec/output-schemas/setup-activation-result.schema.json`, `test/cli/setup-activation.test.ts`, `test/cli/setup.test.ts`, `test/spec/schemas/setup-activation-result.test.ts`

### Frozen contract

- Selection is `--connector <id>`, repeatable. Default is no connector work. The accepted IDs and fixed kind/target/scope come from the existing fn-94 connector definitions: `claude-code-skill`, `claude-desktop-mcp`, `cursor-mcp`, `codex-skill`, `opencode-skill`, `openclaw-skill`, and `hermes-skill`. Exact duplicate selections dedupe in first-seen order. Unknown IDs fail CLI validation before setup or connector side effects.
- Without `--connector`, terminal and JSON output remain the unchanged `setup-command-result@1.0`. With at least one connector selection, JSON emits one new closed `setup-activation-result@1.0` object that references an unchanged `setup-command-result@1.0` plus per-target results containing a nullable shipped `ActivationVerificationReceipt@1.0`; it does not copy or reopen the setup, semantic, folder, or activation schemas.
- Connector installation or execution starts only after `setup()` returns exit 0 with a completed `FolderSetupReceipt@1.0`, `activation.ready=true`, and a non-empty exact result URI. A lexical failure returns its original setup status/exit code and an empty connector result list. Connector success is never serialized beside lexical failure.
- Missing selected targets install once through the existing read-only installer with the setup index/config context. Existing valid entries are reused byte-for-byte; setup never implicitly reinstalls or overwrites them. Invalid/unreadable existing configuration is preserved and reported with bounded remediation.
- Each target result contains only `connectorId`, `kind`, `target`, `scope`, `installation` (`installed|reused|failed`), `verification` (`passed|failed|skipped|not_run`), a bounded code/remediation, and a nullable shipped activation receipt. Never include config paths, raw connector stdout/stderr, corpus text, or unbounded errors.
- MCP targets use `verifyInstalledConnector`/`verifyConnectorActivation` for the existing bounded read-only smoke. Installed skill targets have no safe runtime hook and therefore return `skipped/target_runtime_unverifiable`; they are never described as executed.
- Connector/install failures do not roll back or relabel proven lexical setup. The outer status is `completed` only when every requested connector passed; otherwise it is `completed_with_actions`. Both retain exit 0 after lexical success. Per-target remediation explains rerun/recovery.
- Reruns preserve collection/config/idempotency. Passed connector receipts may reuse the shipped exact-fingerprint cache; deterministic pre-probe states keep shipped semantics; recoverable failures retry. No setup TTL/cache or semantic-job-derived identity is introduced.
- Direct `gno setup` opens its own standalone store for connector composition after the lexical setup store closes. It never probes, attaches to, or queues through a resident, Web, MCP, or Desktop runtime.
- Existing Web/Desktop behavior is authoritative and unchanged: passive status never verifies or spawns; explicit `POST /api/connectors/verify` remains the only resident action and keeps its existing privacy-bounded split lexical/connector projection. No UI/API duplication in this task.
- Preserve fn-105.2 semantic identity and `--no-semantic` live-owner behavior. Connector identity/retry never depends on semantic status, job ID, PID, timestamps, tokens, or collection disposition.
- Provide only a narrow injected advisory profile-discovery seam for future fn-107 composition. No fn-107 implementation is present: this task does not parse `.gno/index.yml`, auto-select connectors, or mutate setup from a profile. Absent, invalid, or throwing discovery remains non-blocking and behaviorally identical to no profile.

### Required investigation

Read the landed folder/setup receipts and schemas, setup CLI/semantic scheduler, activation verifier/status/receipt types, connector definitions/install/status/verifier/remediation, explicit Web connector route/projection, and focused tests before implementation.
## Acceptance
- [ ] No-connector `gno setup` remains contract-compatible and emits unchanged terminal/`setup-command-result@1.0` output; connector mode emits exactly one validated `setup-activation-result@1.0` JSON object referencing the closed setup and activation schemas.
- [ ] `--connector <id>` is repeatable, defaults to none, dedupes exact repeats deterministically, accepts only the seven current fn-94 connector IDs, and unknown selection fails before setup/connector side effects.
- [ ] Install/verify begins only after setup exit 0 plus completed/ready exact lexical evidence. Lexical failure keeps its original status and exit 1/2, returns no connector successes, and performs no connector install/spawn.
- [ ] Missing targets install once through existing read-only installers with selected index/config context; already-installed entries are reused without overwrite; malformed/unreadable entries are preserved and receive bounded failure remediation.
- [ ] Per-target output contains fixed ID/kind/target/scope, separate installation and verification states, bounded code/remediation, and a nullable shipped `ActivationVerificationReceipt@1.0`; config paths, raw child output, corpus text, and unbounded errors never appear.
- [ ] Requested MCP targets run the shipped bounded read-only smoke. Installed skill targets return `skipped/target_runtime_unverifiable` and are never claimed as runtime-verified.
- [ ] Connector failure/skips produce `completed_with_actions` and exit 0 after lexical success; they do not roll back setup, mutate `FolderSetupReceipt@1.0`, change semantic status, or alter status/doctor/health semantics.
- [ ] Rerun tests prove collection/config/install idempotency, passed exact-fingerprint receipt reuse, and recoverable verification retry without duplicate connector spawn or a second cache/fingerprint model.
- [ ] Direct CLI connector composition uses a standalone store and never contacts or attaches to resident/Web/MCP/Desktop runtime. Existing passive Web/status paths remain spawn-free and existing explicit connector verify API/projection remains unchanged.
- [ ] Semantic source identity and `--no-semantic` live PID ownership are unchanged and independent of connector execution/results.
- [ ] Optional future profile discovery is injected/advisory only; absent, invalid, or throwing discovery cannot select a connector, mutate config, fail basic setup, or create destructive ambiguity.
- [ ] Focused CLI/schema/integration tests, full `bun test`, `bun run lint:check`, `bun run typecheck`, docs verification, Flow validation, fresh inherited review, commit, push, and clean branch all pass.
## Done summary
Implemented verified connector activation after folder setup.

- Added repeatable `gno setup <folder> --connector <id>` support for the seven shipped connector targets.
- Preserved the existing `setup-command-result@1.0` output when no connector flag is supplied.
- Added the bounded `setup-activation-result@1.0` contract for connector-mode results.
- Gated connector installation and smoke verification on proven lexical setup success.
- Preserved existing and malformed connector configurations; missing targets install once without overwriting.
- Added fail-bounded connector store lifecycle handling, bounded remediation, and raw-error redaction.
- Added CLI, lifecycle, schema, and connector regression coverage plus user-facing CLI documentation.
- Fresh implementation review verdict: SHIP.
## Evidence
- Commits: f304f8e
- Tests: bun test test/cli/setup-activation.test.ts test/cli/setup-activation-command.test.ts test/cli/setup-activation-lifecycle.test.ts test/spec/schemas/setup-activation-result.test.ts test/serve/connectors.test.ts, bun test, bun run lint:check, bun run typecheck, bun run docs:verify, git diff --check, .flow/bin/flowctl validate --spec fn-105 --json
- PRs: