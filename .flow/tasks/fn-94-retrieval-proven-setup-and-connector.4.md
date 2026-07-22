---
satisfies: [R4, R5, R6]
---
# fn-94-retrieval-proven-setup-and-connector.4 Lock activation parity privacy and documentation

## Description
Deliver lock activation parity privacy and documentation as one implementation-sized increment.

**Size:** M
**Files:** `test/core/activation-verifier.test.ts`, `test/core/connector-verifier.test.ts`, `test/store/activation-receipts.test.ts`, `test/spec/schemas/activation-verification.test.ts`, `test/cli/doctor.test.ts`, `test/cli/status.test.ts`, `test/serve/api-status.test.ts`, `docs/QUICKSTART.md`, `docs/INSTALLATION.md`, `docs/TROUBLESHOOTING.md`, `docs/CLI.md`, `docs/API.md`, `docs/MCP.md`, `assets/skill/SKILL.md`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

### Approach
- Consolidate the fn-94.1 core/store/schema fixtures with fn-94.2 connector and fn-94.3 core/CLI/REST/UI fixtures into one parity matrix. Do not duplicate already-covered lexical cases; add the missing cross-surface, connector, semantic-state, aggregation, no-network/no-child-spawn, status-performance, and exit-code assertions.
- Lock the published `ActivationVerificationReceipt@1.0` contract: four stages, all statuses/codes, strict ready/stage/evidence invariants, RFC 3339 dates, 16 KiB bound, target-specific receipt keys, and invalidation after document, schema/tokenizer, or FTS-state changes.
- Prove privacy at the SQLite and surface boundaries: no raw probe term/query/snippet/passage, no unrestricted connector output, and no corpus content sent to remote providers. Assert passive status/doctor/Web/API checks neither call `verifyConnectorActivation`/`verifyInstalledConnector`, spawn connector children, download models, nor invoke remote inference. If these surfaces expose connector receipts, cover the bounded StorePort load/list path and prove it cannot become an unbounded scan or active verification path.
- Document exact semantics: lexical proof determines immediate usability; semantic may be pending; requested connector health is separate; MCP targets run a bounded tool/search smoke; skill presence is reported as installed but runtime verification is `skipped` unless the client exposes a safe read-only hook.
- Update repo docs/skill plus canonical hosted `gno.sh` install/troubleshooting language. Run docs sync/verification and package smoke. Because CLI/MCP behavior changes, run the GNO skill autoresearch workflow and copy/reinstall the winning skill only if the current asset no longer scores 100%.

### Baseline already delivered by fn-94.1
- Migration 012 and strict bounded receipt storage/parsing.
- Tokenizer-aware Unicode probes, collection-scoped BM25, exact URI/source/mirror match, corpus-keyed probe digests, fair candidate selection, and FTS-state fingerprint invalidation.
- Regressions for empty/stopword-only/non-Latin/full-width/trigram/mismatch/ingestion-race/FTS-loss/shared-term/mixed-corpus/corrupt-row and schema readiness cases.

### Shipped fn-94.2 contracts to preserve
- Active connector verification is exposed as `verifyConnectorActivation` plus `ConnectorVerificationTarget` (`McpConnectorVerificationTarget` / `SkillConnectorVerificationTarget`) in `src/core/connector-verifier.ts`, and `verifyInstalledConnector` in `src/serve/connectors.ts`; passive surfaces must not invoke either verifier.
- Connector remediation must come from `getConnectorVerificationRemediation`, keyed by the bounded verification code and structured connector target, with no persisted arbitrary text or path leakage.
- Semantic `pending` remains independent of lexical usability. This task locks fn-94.3's rule that status/onboarding never claims semantic `passed` before a later fingerprinted semantic verifier exists.
- `/api/health` remains liveness-only. Activation is additive to existing status output; `gno status` exits 0 when unhealthy and `gno doctor` exits 2 only for lexical-unhealthy activation.

### Investigation targets
**Required** (read before coding):
- `test/spec/schemas`
- `test/core/activation-verifier.test.ts`
- `test/store/activation-receipts.test.ts`
- `test/core/activation-status.test.ts`
- `test/serve/public/components/BootstrapStatus.test.tsx`
- `test/serve/public/components/FirstRunWizard.test.tsx`
- `test/serve/public/components/HealthCenter.test.tsx`
- `docs/QUICKSTART.md`
- `docs/INSTALLATION.md`
- `assets/skill/SKILL.md`
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`

**Optional** (reference as needed):
- `docs/MCP.md`
- `docs/API.md`
- `docs/CLI.md`
## Acceptance
- [ ] Schema and parity fixtures cover every stage/status/failure code.
- [ ] Tests prove activation sends no corpus content to remote providers and stores no passage text.
- [ ] Parity tests prove passive status/doctor/Web/API paths never spawn connector children, use bounded persisted receipt access when connector projection is present, keep semantic pending separate from lexical usability, preserve additive status fields and documented exit semantics, and retain the status latency safeguard.
- [ ] All relevant docs, skill assets, hosted install guidance, docs verification, package smoke, and skill eval are current.
- [ ] Docs and UI make the MCP-versus-skill verification boundary explicit and never call file presence a successful runtime smoke.
- [ ] Full gates include lint/typecheck/format, `bun test`, retrieval evals affected by activation, docs verification, package smoke, and the skill autoresearch check required by changed CLI/MCP behavior.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
