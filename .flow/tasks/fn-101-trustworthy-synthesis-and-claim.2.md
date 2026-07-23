---
satisfies: [R1, R3, R4, R6]
---
# fn-101-trustworthy-synthesis-and-claim.2 Add bounded semantic claim-to-evidence verification

## Description
Deliver add bounded semantic claim-to-evidence verification as one implementation-sized increment.

**Size:** M
**Files:** `src/pipeline/claim-verifier.ts`, `src/llm/types.ts`, `src/llm/nodeLlamaCpp/generation.ts`, `test/pipeline/claim-verifier.test.ts`

### Approach
- Verify each substantive claim only against the closed set of exact Capsule spans using schema-constrained output and hard data delimiters.
- Bind non-insufficient verdicts to exact evidence IDs/lines/hashes and expose verifier/model/config fingerprints.
- When no verifier is available, return deterministic citation-hygiene results plus an explicit semantic-verification-unavailable capability; never fabricate confidence.

### Investigation targets
**Required** (read before coding):
- `src/llm/types.ts`
- `src/llm/nodeLlamaCpp/generation.ts`
- `src/pipeline/answer.ts:435-560`

**Optional** (reference as needed):
- `src/llm/policy.ts`
- `src/llm/cache.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/core/context-evidence.ts`

### Key context
- Retrieved text is data, not verifier instructions; adversarial schema/prompt override attempts must remain quoted evidence.

## Acceptance
- [ ] Semantic verdicts reference only exact Capsule evidence and validate against the shared schema.
- [ ] Prompt-injection fixtures cannot alter verdict policy, tool behavior, or output schema.
- [ ] Verifier absence/failure degrades explicitly to deterministic hygiene without a verified claim.


## Done summary
Added a bounded one-call semantic verifier over exact unchanged Capsule evidence, local JSON-Schema grammar enforcement, strict post-model partition/evidence validation, adversarial data delimiters, and explicit unavailable/failed capability states.
## Evidence
- Commits: a57d19f
- Tests: bun test node structured/http generation and claim verifier suites (39 pass), bun run lint:check, independent read-only review: SHIP
- PRs: