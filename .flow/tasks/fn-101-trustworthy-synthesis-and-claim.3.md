---
satisfies: [R1, R2, R5, R6]
---
# fn-101-trustworthy-synthesis-and-claim.3 Integrate verified synthesis across Ask surfaces

## Description
Deliver integrate verified synthesis across ask surfaces as one implementation-sized increment.

**Size:** M
**Files:** `src/pipeline/answer.ts`, `src/cli/commands/ask.ts`, `src/serve/routes/api.ts`, `src/mcp/tools/query.ts`, `src/sdk/client.ts`, `test/pipeline/verified-ask-parity.test.ts`

### Approach
- Build verified Ask on Context Capsules rather than full-document prefixes, preserving raw Ask mode as an explicit compatibility choice during rollout. Compose Capsule build/freshness through `buildContextCapsule` and `verifyContextCapsuleRuntime` so Ask does not recreate input normalization, runtime fingerprint derivation, compiler wiring, or verification wiring.
- Return answer, per-claim verdicts, exact support/conflict spans, gaps, coverage, abstention, and degraded capability through one result contract. Derive degradation from the Capsule's requested/attempted/outcome `retrieval.capabilityStates`, not from ambiguous capability booleans or the mere absence of a fallback.
- Use the same defaults/thresholds and readable rendering across CLI, REST, MCP, SDK, and Web.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/answer.ts:435-560`
- `src/cli/commands/ask.ts`
- `src/serve/routes/api.ts:3744-3820`
- `src/sdk/client.ts`
- `src/mcp/tools/query.ts`

**Optional** (reference as needed):
- `src/serve/public/pages/Ask.tsx`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/app/context-runtime.ts`
- `src/app/context-runtime-types.ts`
## Acceptance
- [ ] All surfaces emit schema-equivalent claims/verdicts/evidence/gaps/coverage.
- [ ] Below-threshold support yields explicit abstention instead of an unsupported answer.
- [ ] Contradiction and missing evidence remain distinct in JSON and readable output.
- [ ] Verified Ask preserves the normalized Capsule retrieval request for reproducibility, distinguishes `not_requested` from attempted `unavailable`, and uses each surface's canonical effective index so freshness verification fails closed on an index mismatch.
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.5 introduced buildContextCapsule and verifyContextCapsuleRuntime as the shared surface composition boundary -->
<!-- Updated by plan-sync (cross-spec): fn-98-context-capsule-mvp.5 review fixes made retrieval request, capability outcome, and runtime-index authority explicit -->


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
