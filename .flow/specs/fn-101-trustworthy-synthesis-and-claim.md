# fn-101 Trustworthy Synthesis and Claim Verification

## Goal & Context
<!-- scope: business -->

Build immediate answer-time verification on top of Context Capsule evidence. Users and agents should receive claims classified as supported, contradicted, insufficient, or uncertain, bound to exact source lines and hashes, with abstention when support is inadequate.

## Architecture & Data Models
<!-- scope: technical -->

Add a shared verification pipeline after answer generation:

1. Split the answer into normalized substantive claims while preserving character spans.
2. Match candidate Capsule evidence spans deterministically, then invoke the configured local verifier only where semantic judgment is required.
3. Emit `ClaimVerification`: claim text/span, status, confidence, supporting/contradicting evidence IDs and exact lines/hashes, rationale code, and verifier fingerprint.
4. Aggregate coverage/conflict thresholds into answer status and abstention guidance.

Verification prompts accept only the closed Capsule evidence set, hard-delimit untrusted content, and require schema-constrained output. Unsupported citations are removed or cause an abstention rather than being silently retained.

## API Contracts
<!-- scope: technical -->

- Ask CLI/REST/MCP/SDK add an opt-in verification mode and structured `verification` payload; presets may make it default only after measured gates.
- Status enum: `supported|contradicted|insufficient|uncertain`; answer status includes coverage and abstention reason.
- Every evidence reference resolves to a Capsule evidence ID, URI, line range, and hashes.
- Verifier unavailable/offline returns an explicit degraded state; extractive citation hygiene still runs.
- New/updated output schemas are additive and versioned.

## Edge Cases & Constraints
<!-- scope: technical -->

- Handle compound claims, quotations, numbers/dates, hedging, negation, and mutually conflicting sources.
- Distinguish absence of evidence from contradiction.
- Never let source text inject verifier instructions or output schema fields.
- Verification cannot cite evidence omitted from the Capsule budget.
- Deterministic claim splitting and citation resolution must be testable without a model.
- Cap claim count/model calls and preserve latency/explain telemetry.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Verified Ask outputs classify every substantive claim using the four-state contract and bind non-insufficient verdicts to exact Capsule evidence.
- **R2:** Contradiction and missing-evidence fixtures produce correct distinct statuses; coverage below threshold causes explicit abstention.
- **R3:** Unsupported, stale, malformed, and out-of-Capsule citations cannot survive as valid support.
- **R4:** Adversarial prompt-injection fixtures cannot alter verification policy, schema, or tool behavior.
- **R5:** CLI, REST, MCP, SDK, schemas, docs, and readable output share one verification result.
- **R6:** Deterministic stages run without a model; verifier unavailability degrades explicitly without fabricating confidence.
- **R7:** `fn-97` cases show no answer-accuracy regression and a measurable reduction in unsupported substantive claims.

## Boundaries
<!-- scope: business -->

No corpus-wide contradiction audit (`fn-86` territory), autonomous multi-round thinking, source rewriting, legal/factual guarantee, or use of evidence outside the supplied Capsule.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Citation presence alone is not trust. Claim-level support and explicit gaps turn GNO's exact evidence spans into an answer contract agents can inspect and act on.

### Implementation Tradeoffs
<!-- scope: technical -->

Closed-evidence verification is intentionally narrower than open-web fact checking. It is reproducible and privacy-preserving, and it avoids GBrain-style loops that claim gap filling without actually retrieving new evidence.

## Implementation Plan

1. `fn-101-trustworthy-synthesis-and-claim.1` — Define claim verification semantics and deterministic hygiene (**M**)
2. `fn-101-trustworthy-synthesis-and-claim.2` — Add bounded semantic claim-to-evidence verification (**M**); depends on `fn-101-trustworthy-synthesis-and-claim.1`
3. `fn-101-trustworthy-synthesis-and-claim.3` — Integrate verified synthesis across Ask surfaces (**M**); depends on `fn-101-trustworthy-synthesis-and-claim.2`
4. `fn-101-trustworthy-synthesis-and-claim.4` — Run adversarial outcome gates and ship truthful verification docs (**M**); depends on `fn-101-trustworthy-synthesis-and-claim.3`

## Quick commands

```bash
bun test test/pipeline/claim-verification*
bun run eval:agentic
.flow/bin/flowctl validate --spec fn-101-trustworthy-synthesis-and-claim --json
```

## References

- `src/pipeline/answer.ts:114-178` — citation hygiene.
- `src/pipeline/answer.ts:435-560` — grounded answer generation.
- [OWASP prompt injection guidance](https://genai.owasp.org/llmrisk/llm01-prompt-injection/).

## Early proof point

Task `fn-101-trustworthy-synthesis-and-claim.1` validates the core approach (deterministic claim/citation hygiene separates unsupported, contradicted, and insufficient outcomes on closed Capsule evidence).
If it fails, re-evaluate the substantive-claim segmentation and four-state verdict semantics before continuing with `fn-101-trustworthy-synthesis-and-claim.2`+.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | Verified Ask outputs classify every substantive claim using the four-state contract and bind non-insufficient verdicts to exact Capsule evidence. | fn-101-trustworthy-synthesis-and-claim.1, fn-101-trustworthy-synthesis-and-claim.2, fn-101-trustworthy-synthesis-and-claim.3 | — |
| R2 | Contradiction and missing-evidence fixtures produce correct distinct statuses; coverage below threshold causes explicit abstention. | fn-101-trustworthy-synthesis-and-claim.1, fn-101-trustworthy-synthesis-and-claim.3, fn-101-trustworthy-synthesis-and-claim.4 | — |
| R3 | Unsupported, stale, malformed, and out-of-Capsule citations cannot survive as valid support. | fn-101-trustworthy-synthesis-and-claim.1, fn-101-trustworthy-synthesis-and-claim.2 | — |
| R4 | Adversarial prompt-injection fixtures cannot alter verification policy, schema, or tool behavior. | fn-101-trustworthy-synthesis-and-claim.2, fn-101-trustworthy-synthesis-and-claim.4 | — |
| R5 | CLI, REST, MCP, SDK, schemas, docs, and readable output share one verification result. | fn-101-trustworthy-synthesis-and-claim.3, fn-101-trustworthy-synthesis-and-claim.4 | — |
| R6 | Deterministic stages run without a model; verifier unavailability degrades explicitly without fabricating confidence. | fn-101-trustworthy-synthesis-and-claim.1, fn-101-trustworthy-synthesis-and-claim.2, fn-101-trustworthy-synthesis-and-claim.3 | — |
| R7 | `fn-97` cases show no answer-accuracy regression and a measurable reduction in unsupported substantive claims. | fn-101-trustworthy-synthesis-and-claim.4 | — |

## Sync Log

- 2026-07-23T10:50:38.590Z — **Gordon Mickel (Linear)**:

  Implementation started on `feat/trustworthy-synthesis`.

  Task 1 focus: deterministic claim segmentation, exact citation offsets, closed Capsule identity/freshness validation, four-state contract, strict schema parity, and abstention aggregation. Semantic support remains explicitly separate from citation presence.

- 2026-07-23T11:08:00.460Z — **Gordon Mickel (Linear)**:

  Task 1 complete on the feature branch.

  - `90bacb5` deterministic claim verification contract
  - `d020d55` Flow completion metadata
  - Exact UTF-16 spans, closed Capsule/freshness identity, strict four-state semantics, 100% support gate, hygiene abstention, strict Zod/JSON schema parity
  - Host gate: 26 focused/answer tests, type-aware lint and format clean
  - Independent review: SHIP

  Task 2 semantic verifier is now in progress.

- 2026-07-23T11:21:22.428Z — **Gordon Mickel (Linear)**:

  Task 2 complete on the feature branch.

  - `a57d19f` bounded semantic verifier and structured-generation capability
  - `8793389` Flow completion metadata
  - Local GGUF JSON-Schema grammar enforcement; HTTP structured verification explicitly unavailable before network
  - One-call, closed-evidence verifier with strict post-model claim/evidence partition validation and injection fixtures
  - Host gate: 39 focused tests; lint/typecheck/format clean
  - Independent review: SHIP

  Task 3 cross-surface verified Ask integration is in progress.
