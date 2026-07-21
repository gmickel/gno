# fn-98 Context Capsule MVP

## Goal & Context
<!-- scope: business -->

Build GNO's flagship evidence primitive: a deterministic, token-budgeted, citation-complete Context Capsule that lets an agent request a goal once and receive sufficient, diverse, verifiable evidence without orchestrating query, diagnose, get, and line-range calls manually.

## Architecture & Data Models
<!-- scope: technical -->

Add a shared `ContextCompiler` core over existing hybrid retrieval, section addressing, graph hints, source hashes, temporal metadata, and `fn-93` configured contexts. It derives query facets, retrieves candidates, selects exact sections/chunks by marginal uncovered-facet gain per token, collapses overlap/duplicates, and stops at a global token/byte budget.

Versioned `ContextCapsuleV1`:

- `schemaVersion`, `capsuleId`, goal/query, index and collection scope
- requested/used token and byte budgets
- retrieval plan, filters, depth policy, capabilities/fallbacks
- model/config/index fingerprints
- ordered `evidence[]`: URI/docid/title/heading, exact line range, extractive text, source/mirror hashes, modified/document/observed dates, configured context, trust/egress classification
- `coverage`: facets covered, unresolved facets, explicit evidence gaps
- omitted candidates with deterministic reasons
- truncation and warning state

Canonical JSON serialization excludes volatile timing. Readable Markdown is a projection of the same object. Verification re-resolves each source and reports `unchanged|stale|missing|reranked`, without silently rebuilding.

## API Contracts
<!-- scope: technical -->

- CLI: `gno context build "<goal>" --budget <tokens> [filters] --json|--md`; `gno context verify <file|-> --json|--md`.
- MCP: read-only `gno_context` and `gno_context_verify`.
- SDK: `client.context(input)` and `client.verifyContext(capsule)`.
- REST: `POST /api/context`, `POST /api/context/verify`.
- New draft-07 output schemas and contract tests; all surfaces wrap the shared compiler/verifier.
- Deterministic errors distinguish invalid budget/input, no evidence, incomplete coverage, unavailable capability, and stale verification.

## Edge Cases & Constraints
<!-- scope: technical -->

- Extractive only in V1; never fabricate a summary to fill a gap.
- Treat indexed text as untrusted data; hard-delimit source passages from instructions.
- Unicode-aware token estimation must be conservative when the active tokenizer is unavailable.
- One large document cannot consume the entire budget unless it is the only relevant source.
- Preserve exact lines after canonical mirror conversion; report source/mirror hash drift.
- Respect collection filters, indexed URI selection, context scopes, offline mode, and egress policy when present.
- Identical inputs/index/config produce byte-identical canonical JSON.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** One shared compiler emits schema-valid V1 Capsules across CLI, REST, MCP, and SDK with cross-surface parity fixtures.
- **R2:** Every evidence item carries an extractive passage, exact line range, URI/docid, source/mirror hashes, dates when known, and reproducibility fingerprints.
- **R3:** Selection enforces one global budget, collapses overlap, rewards uncovered facet coverage, and reports omitted candidates/gaps explicitly.
- **R4:** Verification classifies unchanged, stale, missing, and reranked evidence without mutating or silently rebuilding the Capsule.
- **R5:** Prompt-injection fixtures prove retrieved instructions remain data and cannot alter compiler/tool policy.
- **R6:** The `fn-97` comparison meets all encoded promotion gates: no task-accuracy loss, 25% fewer calls, 35% less context, 95% claim-span linkage, deterministic canonical output.
- **R7:** Specs, schemas, docs, skill assets, examples, and hosted gno.sh surfaces ship together with a reproducible before/after demo.

## Boundaries
<!-- scope: business -->

No lossy LLM summary requirement, autonomous multi-round research, answer generation, hidden ranking personalization, remote sharing, or removal of raw search/get tools.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

GNO has capable primitives but asks every agent to reinvent evidence gathering and budget management. A Capsule makes trustworthy context the product output and creates a reusable foundation for agents, Ask, publishing, audits, and handoffs.

### Implementation Tradeoffs
<!-- scope: technical -->

An extractive deterministic compiler is less fluent than synthesis but much easier to verify, cache, compare, and secure. Facet-aware selection improves diversity without introducing opaque autonomous loops.
