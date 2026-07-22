---
satisfies: [R2, R3, R6]
---
# fn-105-verified-folder-setup.3 Integrate connector verification onboarding and optional profiles

## Description
Deliver integrate connector verification onboarding and optional profiles as one implementation-sized increment.

**Size:** M
**Files:** `src/core/folder-setup.ts`, `src/core/connector-verifier.ts`, `src/serve/routes/api.ts`, `src/serve/public/components/FirstRunWizard.tsx`, `test/setup/setup-integration.test.ts`

### Approach
- Compose fn-94 target-specific connector receipts after lexical proof without accepting trust/auth prompts or converting optional failure into false lexical setup failure. Supported local MCP targets run the bounded tool/status/search smoke; skill targets without a safe client runtime hook return explicit `skipped/target_runtime_unverifiable` rather than treating installed files as execution proof.
- Expose the same receipt in Web/Desktop handoff and resident status.
- Add a narrow optional profile-discovery hook that can consume fn-107 once present; setup remains fully functional without `.gno/index.yml`.

### Investigation targets
**Required** (read before coding):
- `src/serve/routes/api.ts`
- `src/serve/public/components/FirstRunWizard.tsx`
- `src/serve/public/components/BootstrapStatus.tsx`

**Optional** (reference as needed):
- `src/serve/connectors.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/core/connector-verifier.ts`
- `src/core/project-profile.ts`

### Key context
- Avoid a spec cycle: the setup core ships first; fn-107 later supplies the optional profile compiler integration contract.
- For R3, “supported” means an fn-94 execution-capable target: a safe local MCP config today or a future skill client with a read-only runtime hook. Installed skill files without such a hook complete verification truthfully as `skipped/target_runtime_unverifiable` under the partial-stage contract; setup must not relabel that as a runtime pass.

## Acceptance
- [ ] Requested supported local MCP connector completes a real read-only verification or returns explicit pending/failed remediation; unverifiable skill runtimes return an explicit skipped state and are never reported as executed.
- [ ] CLI/Web/Desktop show the same setup and activation stage receipt.
- [ ] Absence, invalidity, or future presence of a project profile never makes basic setup ambiguous or destructive.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
