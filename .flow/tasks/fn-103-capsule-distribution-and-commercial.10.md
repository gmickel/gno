---
satisfies: [R3, R5]
---
# fn-103-capsule-distribution-and-commercial.10 Harden Context Capsule demo artifact integrity

## Description
Remediate fn-103.3 review findings in the committed three-way demo contract without reopening the completed delivery task.

**Size:** S
**Files:** `evals/agentic/demos/context-capsule.ts`, `evals/agentic/demos/context-capsule-types.ts`, `evals/agentic/schemas/context-capsule-demo.schema.json`, `test/eval/agentic/context-capsule-demo.test.ts`, `spec/evals-agentic.md`

### Approach
- Separate the benchmark run's clean Git provenance from the commit that contains the derived demo artifact; never encode an impossible self-referential artifact commit inside the artifact.
- Validate every source artifact canonical fingerprint before projecting it.
- Bind the complete shared task/trial/seed/agent/environment identity across lanes.
- Parse the delivered Capsule payload and validate request, effective index, fallbacks, capability state, and full normalized payload.
- Recompute every displayed metric from the embedded raw receipt/score and reject any drift.
- Add adversarial multi-trial selection and field-tampering coverage.

## Acceptance
- [ ] Artifact provenance distinguishes source-run commit from external containing-artifact commit semantics without self-reference.
- [ ] Generator rejects source report or Verified Ask fingerprint/content drift.
- [ ] Validator rejects cross-lane task, trial, seed, agent, environment, payload, fallback, request, index, capability, score, or displayed-metric drift.
- [ ] Tests prove deterministic selection with multiple matching trials and fail closed for every public metric/payload tamper class.
- [ ] Focused and full relevant GNO gates pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
