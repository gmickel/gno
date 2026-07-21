# fn-94 Retrieval-Proven Setup and Connector Activation

## Goal & Context
<!-- scope: business -->

Activation must end with proof that GNO can retrieve useful evidence through the installed client, not merely that folders, models, and indexes exist. Extend current onboarding/health flows with a deterministic corpus-derived retrieval check and an MCP/skill connector smoke so a green state means the product is actually usable.

## Architecture & Data Models
<!-- scope: technical -->

Add a shared activation verifier used by CLI health/setup surfaces and the Web/Desktop onboarding state. It selects a safe deterministic query from indexed corpus terms, runs lexical retrieval immediately, validates a result from the intended collection, then optionally verifies semantic retrieval when embeddings are ready. Connector verification invokes the installed target through its normal status/tool-list path and a read-only search smoke without mutating client config.

Persist only a bounded receipt: collection/index fingerprint, check stages, timestamps, result URI/hash, connector target, latency, and redacted failure code. Never persist the source passage or arbitrary query history.

## API Contracts
<!-- scope: technical -->

- Shared `ActivationVerificationResult` with stages `index`, `lexical`, `semantic`, `connector` and statuses `passed|pending|failed|skipped`.
- CLI health/setup JSON and REST bootstrap/health responses expose the receipt additively.
- Web/Desktop onboarding shows the exact failed stage and remediation.
- Connector smoke is read-only and target-specific; unsupported targets report `skipped`, not success.

## Edge Cases & Constraints
<!-- scope: technical -->

- Tiny, empty, binary-only, stopword-only, and non-Latin corpora require deterministic query selection or an explicit `no_probe_term` failure.
- Lexical proof must not wait for model downloads.
- Semantic proof may remain pending while background embedding proceeds.
- Never send corpus text to a remote model/provider as part of activation.
- Connector auth/trust prompts remain user-owned; verification must not bypass them.
- Receipts are invalidated by collection/index fingerprint changes.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** A newly indexed text corpus can complete a lexical retrieval proof before semantic models finish downloading.
- **R2:** Verification fails clearly when the expected collection cannot return its corpus-derived result; readiness cannot remain falsely green.
- **R3:** Supported installed MCP/skill targets complete a real read-only tool/search smoke with target-specific evidence.
- **R4:** Empty/unsupported corpora and unavailable connectors produce explicit pending/skipped/failed states with remediation, never silent success.
- **R5:** CLI, REST, Web/Desktop health, docs, and schemas consume one shared result contract.
- **R6:** Activation receipts are bounded, privacy-preserving, fingerprinted, and covered by invalidation tests.

## Boundaries
<!-- scope: business -->

No new one-command folder setup UX (owned by `fn-105`), no automatic trust-dialog acceptance, no remote telemetry, no benchmark score claim, and no requirement that embeddings be ready before lexical use.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Users currently can finish onboarding with a technically initialized but practically unusable system. A real retrieval and connector proof shortens time-to-value and makes failures actionable.

### Implementation Tradeoffs
<!-- scope: technical -->

A corpus-derived lexical probe is immediate and local. Semantic and connector stages remain independent so slow downloads or optional clients do not erase truthful partial readiness.

## Implementation Plan

1. `fn-94-retrieval-proven-setup-and-connector.1` — Define activation receipt and lexical proof core (**M**)
2. `fn-94-retrieval-proven-setup-and-connector.2` — Add read-only connector verification adapters (**M**); depends on `fn-94-retrieval-proven-setup-and-connector.1`
3. `fn-94-retrieval-proven-setup-and-connector.3` — Integrate activation into CLI REST and onboarding health (**M**); depends on `fn-94-retrieval-proven-setup-and-connector.1`, `fn-94-retrieval-proven-setup-and-connector.2`
4. `fn-94-retrieval-proven-setup-and-connector.4` — Lock activation parity privacy and documentation (**M**); depends on `fn-94-retrieval-proven-setup-and-connector.3`

## Quick commands

```bash
bun test test/activation test/cli/doctor* test/serve
bun run docs:verify
.flow/bin/flowctl validate --spec fn-94-retrieval-proven-setup-and-connector --json
```

## References

- `src/cli/commands/doctor.ts` — current diagnostics.
- `src/serve/routes/api.ts:732-780` — shallow health/status surfaces.
- `src/serve/connectors.ts:135` — installed/configured connector status.

## Early proof point

Task `fn-94-retrieval-proven-setup-and-connector.1` validates the core approach (a local corpus-derived lexical probe fails closed when the expected source cannot be retrieved).
If it fails, re-evaluate probe-term derivation and the activation stage contract before continuing with `fn-94-retrieval-proven-setup-and-connector.2`+.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | A newly indexed text corpus can complete a lexical retrieval proof before semantic models finish downloading. | fn-94-retrieval-proven-setup-and-connector.1, fn-94-retrieval-proven-setup-and-connector.3 | — |
| R2 | Verification fails clearly when the expected collection cannot return its corpus-derived result; readiness cannot remain falsely green. | fn-94-retrieval-proven-setup-and-connector.1, fn-94-retrieval-proven-setup-and-connector.3 | — |
| R3 | Supported installed MCP/skill targets complete a real read-only tool/search smoke with target-specific evidence. | fn-94-retrieval-proven-setup-and-connector.2 | — |
| R4 | Empty/unsupported corpora and unavailable connectors produce explicit pending/skipped/failed states with remediation, never silent success. | fn-94-retrieval-proven-setup-and-connector.1, fn-94-retrieval-proven-setup-and-connector.2, fn-94-retrieval-proven-setup-and-connector.3, fn-94-retrieval-proven-setup-and-connector.4 | — |
| R5 | CLI, REST, Web/Desktop health, docs, and schemas consume one shared result contract. | fn-94-retrieval-proven-setup-and-connector.3, fn-94-retrieval-proven-setup-and-connector.4 | — |
| R6 | Activation receipts are bounded, privacy-preserving, fingerprinted, and covered by invalidation tests. | fn-94-retrieval-proven-setup-and-connector.1, fn-94-retrieval-proven-setup-and-connector.2, fn-94-retrieval-proven-setup-and-connector.4 | — |
