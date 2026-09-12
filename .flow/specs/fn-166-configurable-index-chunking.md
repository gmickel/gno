# Configurable index chunking

## Conversation Evidence

The quoted research request was supplied by Gordon. Its statements describe the requester's intended experiment; they are not independently verified experiment results.

> user (assessment request): "legit? is this something we can easily accomodate in a way that it is useful for all?"
> user (quoted research request, part 1): "My research looks at how content structure affects machine retrieval — whether writing in discrete, typed units actually changes what a RAG system surfaces, or whether that's just a nice theory content strategists tell each other."
> user (quoted research request, part 2): "The one thing I can't vary is chunking."
> user (quoted research request, part 3): "ChunkerPort.chunk() already takes params, so I wanted to ask whether exposing maxTokens and overlapPercent as config keys or gno update flags is something you'd consider — even undocumented or behind a flag would be enough for research use."
> user (quoted research request, part 4): "With that, chunk size becomes a variable and I could publish something on how structure and chunk boundaries interact."
> user (compatibility clarification): "this will not change anything for existing users that dont care about this or regress in any way right?"
> user (execution authorization): "ok continue with $flow-next-flow until this is released, then we'll draft a reply to the guy, with prose skill, express thanks and interest in his work etc, tell him what we did."

## Goal & Context
<!-- scope: business -->

- Let researchers vary chunk size and overlap when studying how document structure affects retrieval, and make the same controls useful to ordinary GNO users tuning their own corpora. [paraphrase]
- Ship a documented configuration feature with reproducible index state. Treat the proposed research as motivation; this feature does not assert that typed content or any chunk size improves retrieval. [inferred]

## Architecture & Data Models
<!-- scope: technical -->

- Resolve one chunking policy for each index and apply it consistently wherever that index ingests files or records. Preserve content deduplication and source identity.
- Persist the index target policy and an optimistic generation token. Each store observes the target at open, claims changes with compare-and-set, and checks its token inside the transaction that applies a layout. A stale client fails explicitly and must reopen before changing policy; a newly opened client can intentionally select a new policy. No config-owner registry is introduced.
- Persist the applied policy on the canonical content mirror, which owns the shared chunks. An absent marker on legacy content means the original default. Never increment ingestion version or eagerly backfill/rewrite old chunks to introduce this feature.
- Rechunk pending cached mirrors on an indexing operation using the stored Markdown plus preserved chunking provenance (source path and language hint), or a deterministic active-document representative when legacy provenance is absent. Source availability still governs source refresh; cached layout readiness does not assert that the original source was refreshed. Commit chunks, lexical projection, applied-policy metadata, and vector invalidation atomically. Preserve the existing default ingestion algorithm and path/language behavior.

## API Contracts
<!-- scope: technical -->

- Add documented root chunking configuration for maxTokens and overlapPercent. Preserve defaults of 800 approximate tokens and overlap fraction 0.15 when omitted. Partial configuration inherits each omitted default. maxTokens must be a finite safe integer of at least 10 whose four-character estimate remains safely representable; overlapPercent is a finite fraction from 0 through 0.5 inclusive. Reject invalid values rather than silently clamping user configuration.
- Report configured policy, actual applied policy state, and exact pending mirror/document counts in existing status/diagnostic surfaces, including structured output. Distinguish mixed, empty, and legacy-default state honestly. Keep embedding backlog and source-refresh failures separate from cached chunk-layout readiness.

## Edge Cases & Constraints
<!-- scope: technical -->

- Keep existing source-availability, access, and write-serialization protections during source refresh. Rechunking cached mirrors never reads or changes original files. Failed/interrupted mirror work remains pending and retryable.
- Preserve the current character-based token estimate and automatic boundary selection. The configuration does not introduce exact model tokenization or a new chunking algorithm.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Users can set maxTokens and overlapPercent through documented configuration; omitted settings retain current default chunk output. Upgrading an existing index with omitted or explicitly default settings must not trigger rechunking, re-embedding, or change retrieval behavior solely because of this feature. Default-path parity and no unnecessary work are regression-tested, with a before/after check for material indexing overhead. Errors: invalid numeric types, non-finite values, fractional token limits, and values outside documented supported bounds fail validation before index mutation; valid boundary values are covered by tests. [paraphrase]
- **R2:** All ingestion paths that write the same index use its resolved chunking policy, including ordinary files, record imports, targeted sync, and resident-triggered ingestion. Errors: stale or concurrent clients cannot silently replace a newer target policy or commit chunks under an obsolete generation; they receive an explicit conflict and must reopen/reload.
- **R3:** Changing the policy makes unchanged indexed content eligible for rechunking from cached canonical Markdown on the next applicable indexing operation. Returning to defaults also triggers necessary work. Errors: failed, interrupted, or partially applied mirror work remains pending and retryable; successful work is not falsely marked incomplete or rebuilt unnecessarily. A cached mirror can be rechunked while its original source is unavailable, without claiming source refresh succeeded. Missing source/conversion evidence remains a separate source error rather than invented layout success.
- **R4:** Rechunking refreshes affected lexical data and invalidates embeddings for changed or removed chunks; embedding-capable indexing regenerates required embeddings. A sync-only operation reports remaining embedding work. Errors: obsolete vectors cannot be returned for replaced chunks, duplicate content shares one truthful applied-policy marker, and an identical-policy repeat preserves valid unchanged embeddings. Defaults-to-custom-to-default transitions work even when only one of several duplicate sources was targeted.
- **R5:** Status/diagnostics expose configured versus applied chunking state and distinguish rechunking work from embedding work and source-refresh failures. Errors: legacy indexes and partial failures have explicit states rather than an invented successful policy application; human and structured output agree.
- **R6:** Users can follow a documented procedure to compare two policies in isolated indexes and explicit configuration files against the same unchanged corpus and query set. Validation demonstrates different chunk layouts on a suitable fixture and stable layouts when repeating the same policy. Errors: the procedure identifies incomplete indexing or embedding before comparing results; it makes no quality-improvement promise.
- **R7:** Configuration, indexing, diagnostics, and research guidance are documented on the supported user-facing documentation surfaces. Explain approximate four-characters-per-token sizing, fractional overlap, rebuild cost, cached-mirror versus source freshness, separate-index/config comparisons, and separation of type boosts from structural changes. Errors: examples use supported values and commands and disclose which operations do not generate embeddings.

## Boundaries
<!-- scope: business -->

- No per-collection, per-type, per-language, or per-document chunking policies, concurrent layouts inside one index, or temporary CLI parameter overrides in this feature. [inferred]
- No new chunker algorithm, tokenizer, default tuning, content-type boosting changes, automatic optimization, or dedicated research framework. [inferred]
- Running the requester's study, collecting their corpus, publishing findings, and communicating with them are separate activities. [inferred]

## Decision Context
<!-- scope: both -->

### Motivation
<!-- scope: business -->

- The request identifies chunk size as a missing experimental variable in an otherwise inspectable retrieval stack. General configuration would also let users tune their own document collections. [paraphrase]

### Implementation Tradeoffs
<!-- scope: technical -->

- Prefer persistent, documented index configuration because users need to reproduce the settings that produced their search results. Separate indexes permit comparison without introducing multiple layouts for shared content. [inferred]
- Exposing parameters alone is insufficient because unchanged-source skipping can retain old chunks. Policy-change detection, safe rebuilding, and visible completion state are part of the feature. [inferred]

## Strategy Alignment

- Supports Trustworthy retrieval and evidence, Local knowledge lifecycle, and Coherent agent and application surfaces through reproducible retrieval inputs, dependable rebuilding, and consistent applied settings. [strategy:Local knowledge lifecycle]

## Requirement coverage

| Requirement | Task(s) | Gap justification |
| --- | --- | --- |
| R1 | fn-166.1, fn-166.2, fn-166.4 | |
| R2 | fn-166.1, fn-166.2 | |
| R3 | fn-166.1, fn-166.2 | |
| R4 | fn-166.2 | |
| R5 | fn-166.3 | |
| R6 | fn-166.4 | |
| R7 | fn-166.4 | |

## Early proof point

The policy/state task proves legacy defaults remain untouched and stale store instances cannot advance or apply an obsolete target. The ingestion task then proves atomic shared-mirror transitions using real SQLite and the existing chunker before diagnostics depend on that state.

## Quick commands

Run focused configuration, store, ingestion, and status tests named by each task. Final gates are bun run lint:check, bun test, bun run docs:verify, bun run verify:clipper-package, bun run test:package, and the hybrid evaluation. Use Bun 1.4.2, matching CI. Validate the hosted documentation with its check, typecheck, test, build, and driven page checks before and after deployment.

## Resolved via Research
<!-- provenance: plan short research (repo-scout, spec-scout, memory-scout, docs-gap-scout, flow-gap-analyst) on 2026-09-12 -->

### docs-gap-scout

- Configuration, CLI, API, MCP, and SDK status documentation plus the hosted docs require updates. Source: docs/CONFIGURATION.md, docs/CLI.md, docs/API.md, docs/MCP.md, docs/SDK.md.
- Preserve the existing automatic chunker and document configuration as a later extension; the code-aware ADR is historical. Source: docs/adr/003-code-aware-chunking.md.

No relevant repository memory entry or blocking spec dependency was found. The existing-path retrieval-quality effort and granular model-resolution effort remain separate; this feature does not alter their retrieval or model-selection contracts.
