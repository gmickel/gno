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
