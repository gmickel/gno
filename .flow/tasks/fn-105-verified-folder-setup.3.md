---
satisfies: [R2, R3, R6]
---
# fn-105-verified-folder-setup.3 Integrate connector verification onboarding and optional profiles

## Description
Deliver integrate connector verification onboarding and optional profiles as one implementation-sized increment.

**Size:** M
**Files:** `src/core/folder-setup.ts`, `src/serve/connectors.ts`, `src/serve/routes/api.ts`, `src/serve/status-model.ts`, `src/serve/public/components/FirstRunWizard.tsx`, `test/setup/setup-integration.test.ts`, `test/serve/api-status.test.ts`, `test/serve/public/components/FirstRunWizard.test.tsx`

### Approach
- Compose fn-94 target-specific connector receipts after lexical proof without accepting trust/auth prompts or converting optional failure into false lexical setup failure. Use the shipped `verifyInstalledConnector` entry point for explicit requested verification, which delegates to `verifyConnectorActivation`; pass the shipped `ConnectorVerificationTarget` types (`McpConnectorVerificationTarget` / `SkillConnectorVerificationTarget`) rather than defining a setup-specific target contract, and present remediation via `getConnectorVerificationRemediation`. Supported local MCP targets run the bounded tool/status/search smoke; skill targets without a safe client runtime hook return explicit `skipped/target_runtime_unverifiable` rather than treating installed files as execution proof.
- Expose the same persisted receipt in Web/Desktop handoff and resident status. Explicit setup verification may spawn the policy-approved local connector child; passive status/onboarding rendering must never call either verifier or spawn a child. If passive connector receipt projection is needed, use fn-94.3's bounded StorePort receipt load/list contract rather than runtime verification.
- Preserve fn-94.3 activation semantics and status compatibility: semantic pending is independent of lexical usability and this task must never claim semantic passed; `/api/health` stays liveness-only, and this integration must not change the additive status payload or `gno status`/`gno doctor` exit behavior.
- Add a narrow optional profile-discovery hook that can consume fn-107 once present; setup remains fully functional without `.gno/index.yml`.

### Investigation targets
**Required** (read before coding):
- `src/core/activation-status.ts`
- `src/cli/program.ts`
- `src/serve/routes/api.ts`
- `src/serve/status-model.ts`
- `src/serve/public/components/FirstRunWizard.tsx`
- `src/serve/public/components/BootstrapStatus.tsx`

**Optional** (reference as needed):
- `src/serve/connectors.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/core/connector-verifier.ts`
- `src/serve/connectors.ts`
- `src/core/project-profile.ts`

### Key context
- Avoid a spec cycle: the setup core ships first; fn-107 later supplies the optional profile compiler integration contract.
- For R3, “supported” means an fn-94 execution-capable target: a safe local MCP config today or a future skill client with a read-only runtime hook. Installed skill files without such a hook complete verification truthfully as `skipped/target_runtime_unverifiable` under the partial-stage contract; setup must not relabel that as a runtime pass.
- The fn-94.3 preflight contract is already authoritative for activation aggregation, passive receipt projection, UI state, liveness, status compatibility, exit codes, and status latency. Reuse it; do not add a parallel setup-health model or unbounded status work.

## Acceptance
- [ ] Requested supported local MCP connector completes a real read-only verification or returns explicit pending/failed remediation; unverifiable skill runtimes return an explicit skipped state and are never reported as executed.
- [ ] CLI/Web/Desktop show the same setup and activation stage receipt.
- [ ] UI/API tests distinguish explicit verification from passive rendering: passive onboarding/status never spawns connector children, uses bounded persisted receipt access when projected, preserves semantic-pending/lexical-usable state, and does not regress fn-94.3 status latency or compatibility.
- [ ] Absence, invalidity, or future presence of a project profile never makes basic setup ambiguous or destructive.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
