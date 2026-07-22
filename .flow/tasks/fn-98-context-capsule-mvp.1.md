---
satisfies: [R1, R2, R6]
---
# fn-98-context-capsule-mvp.1 Freeze the Context Capsule V1 contract and canonical identity

## Description
Deliver freeze the context capsule v1 contract and canonical identity as one implementation-sized increment.

**Size:** M
**Files:** `src/core/context-capsule.ts`, `spec/output-schemas/context-capsule-v1.schema.json`, `spec/output-schemas/context-capsule-verification.schema.json`, `test/spec/schemas/context-capsule.test.ts`

### Approach
- Define Capsule/evidence/coverage/omission/fallback structures and reuse the fn-97 receipt/fingerprint vocabulary.
- Canonicalize stable fields, key order, dates, source identifiers, and hashes; keep elapsed timing and other volatile observations outside the comparable payload.
- Treat build output as ephemeral unless the caller explicitly writes it; saved registration and notifications remain fn-102.

### Investigation targets
**Required** (read before coding):
- `src/pipeline/types.ts:25-55`
- `src/store/types.ts`
- `src/core/indexed-reference.ts`
- `test/spec/schemas`

**Optional** (reference as needed):
- `src/publish/artifact.ts`
- `src/bench/types.ts`

### Key context
- Capsule ID is the hash of canonical stable payload fields plus schema version; local output paths are never part of identity.
- Token budget authority and fallback estimator are recorded in capabilities/fallbacks.

## Acceptance
- [ ] Schema validates every required V1 field and rejects unknown incompatible versions.
- [ ] Unchanged fixtures serialize byte-identically across repeated runs and surfaces.
- [ ] Volatile timing, local output paths, and secret configuration cannot change or leak into canonical identity.


## Done summary
Frozen the Context Capsule V1 and verification contracts with deterministic canonical serialization, stable identity, and a non-self-referential token-accounting projection. The contract now enforces Draft/Zod URI and gap parity, exact budget accounting with explicit safety margins, URI/scope/facet bindings, canonical configured-context scopes, revision-bound omissions with deterministic reason counts, and regression coverage for every review finding.
## Evidence
- Commits:
- Tests: bun test test/spec/schemas/context-capsule.test.ts test/spec/schemas/context-capsule-verification.test.ts, bun test test/context test/spec/schemas, bun run typecheck, bun run lint:check, bun run eval:agentic, .flow/bin/flowctl validate --spec fn-98-context-capsule-mvp --json
- PRs: