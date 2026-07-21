---
satisfies: [R2, R3, R6]
---
# fn-105-verified-folder-setup.3 Integrate connector verification onboarding and optional profiles

## Description
Deliver integrate connector verification onboarding and optional profiles as one implementation-sized increment.

**Size:** M
**Files:** `src/core/folder-setup.ts`, `src/core/connector-verifier.ts`, `src/serve/routes/api.ts`, `src/serve/public/components/FirstRunWizard.tsx`, `test/setup/setup-integration.test.ts`

### Approach
- Compose fn-94 connector verification after lexical proof without accepting trust/auth prompts or converting optional failure into false setup failure.
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

## Acceptance
- [ ] Requested supported connector completes a real read-only verification or returns explicit pending/failed remediation.
- [ ] CLI/Web/Desktop show the same setup and activation stage receipt.
- [ ] Absence, invalidity, or future presence of a project profile never makes basic setup ambiguous or destructive.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
