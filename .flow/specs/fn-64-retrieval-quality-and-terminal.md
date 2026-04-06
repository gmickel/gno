# fn-64-retrieval-quality-and-terminal Retrieval quality and terminal navigation upgrades

## Overview

Bring retrieval quality back to the front of the roadmap with five bounded, shippable improvements:

- BM25 regression coverage for lexical edge cases and ranking invariants
- BM25 hardening based on that regression matrix
- code-aware chunking for source files with graceful fallback
- TTY terminal hyperlinks for CLI retrieval output
- per-collection model configuration with clear resolution rules

This epic is intentionally focused on retrieval correctness plus terminal ergonomics, not on broad model/config churn.

## Scope

Included:

- lexical regression matrix for BM25 behavior
- BM25 query parsing/escaping/ranking hardening
- code-aware chunking for selected source file types with fallback to existing chunking
- OSC 8 hyperlinks in TTY terminal output for retrieval surfaces
- per-collection retrieval model overrides that compose cleanly with existing presets
- exact docs/spec/ADR/website updates needed to keep retrieval docs honest

Excluded:

- a new public benchmark CLI in this epic
- changing the default embedding, rerank, or expansion models
- replacing `gno://` URIs with editor-specific URIs in user-facing output

## Approach

### Prior context

- GNO's current retrieval stack already has strong building blocks:
  - document-level BM25
  - chunk-level vectors
  - query expansion
  - RRF fusion
  - best-chunk reranking
- Current architecture/docs describe generic chunking and the hybrid pipeline, but not code-aware chunking:
  - `src/ingestion/chunker.ts`
  - `src/ingestion/sync.ts`
  - `docs/HOW-SEARCH-WORKS.md`
  - `docs/ARCHITECTURE.md`
- Current BM25 path is simpler than it should be for edge cases:
  - FTS query escaping currently whitespace-splits and quotes tokens
  - no explicit field weighting in the `bm25(...)` call
  - no targeted regression suite for hyphenated or underscore-heavy lexical cases
- Current CLI retrieval output prints `gno://...` URIs as plain text:
  - `src/cli/format/search-results.ts`
  - results already carry `source.absPath` and `snippetRange`
- Central config already exists at `~/.config/gno/index.yml`; collection-level overrides should extend that model rather than inventing per-folder config files.
- Only one ADR exists today: `docs/adr/001-scholarly-dusk-design-system.md`. Retrieval/terminal behavior changes need ADR coverage too.

### Reuse anchors

- BM25 lexical entrypoint: `src/store/sqlite/adapter.ts:57`
- BM25 SQL/query shape: `src/store/sqlite/adapter.ts:1083`
- invalid-input mapping already exists: `src/store/sqlite/adapter.ts:1148`
- FTS sync/path/title/body population: `src/store/sqlite/adapter.ts:1163`
- document-level FTS schema: `src/store/migrations/002-documents-fts.ts:23`
- shared terminal formatter: `src/cli/format/search-results.ts:34`
- terminal URI line to wrap: `src/cli/format/search-results.ts:72`
- shared formatter callers:
  - `src/cli/commands/search.ts:119`
  - `src/cli/commands/vsearch.ts:174`
  - `src/cli/commands/query.ts:241`
- result data already has `absPath` + `snippetRange`:
  - `src/pipeline/types.ts:15`
  - `src/pipeline/types.ts:35`
- chunker seam: `src/ingestion/chunker.ts:159`
- ingestion chunker callsite: `src/ingestion/sync.ts:611`
- collection schema: `src/config/types.ts:71`
- model preset schema: `src/config/types.ts:160`
- active preset resolution: `src/llm/registry.ts:53`
- node-llama-cpp adapter preset lookup:
  - `src/llm/nodeLlamaCpp/adapter.ts:72`
  - `src/llm/nodeLlamaCpp/adapter.ts:180`
- current architecture docs for ingestion/search path:
  - `docs/ARCHITECTURE.md:72`
  - `docs/ARCHITECTURE.md:95`

### Related prior work

- `fn-26.1` added `source.absPath`; task `.3` should reuse that path instead of inventing a new resolution path.
- `fn-31-intent-steering-and-rerank-controls.1` and `fn-40-structured-query-document-syntax.1` established the repo pattern that retrieval semantics changes need cross-surface discipline.
- `fn-18.1` and `fn-18.2` already changed FTS/filter/date semantics; BM25 hardening must not regress them.
- `fn-9.1` fixed prior CLI search output instability; terminal-link work should not reintroduce pager/TTY brittleness.
- `fn-34` through `fn-38` already cover retrieval-model experimentation/productization. This epic stays on product-path retrieval behavior, not model-base or training work.

### Product stance

- Retrieval changes should improve correctness first, then ergonomics.
- Tests come before heuristic changes where the current behavior is ambiguous.
- `gno://` remains the canonical display identity; editor-opening behavior is an enhancement layer, not a replacement.
- Code-aware chunking must degrade safely. Unsupported languages and parser failures fall back to the existing chunker.
- Public docs, ADRs, and website copy should describe GNO on its own terms.

### Deliverables

#### 1. BM25 regression matrix

- focused lexical regression tests for:
  - hyphenated compounds
  - digit-hyphen identifiers
  - underscore-heavy identifiers
  - title/path/body ranking expectations
  - collection-filter planner stability
- fixtures that make failures legible and deterministic
- spec/eval docs updated so the matrix is part of ongoing retrieval work, not just a one-off patch

#### 2. BM25 hardening

- explicit lexical semantics backed by the regression suite
- explicit field weighting decision for `documents_fts`
- safer handling of hyphenated and underscore-heavy terms
- no obvious query-planner regressions when collection filtering is enabled
- ADR documenting BM25 query semantics and weighting policy

#### 3. Code-aware chunking

- structural chunk boundaries for supported code files
- graceful fallback to the current chunker for unsupported/failed parse cases
- retrieval validation proving no regressions for prose/markdown flows and measurable gains or at least safer chunk boundaries for code-heavy files
- ADR documenting chunking policy and fallback behavior

#### 4. Terminal hyperlinks

- TTY-only OSC 8 links for terminal output on `search`, `vsearch`, and `query`
- display text remains `gno://...`
- hyperlink targets resolve through `source.absPath` plus best available line hint from `snippetRange`
- configurable editor URI template with sane fallback behavior
- docs and website copy updated so terminal ergonomics are discoverable

#### 5. Per-collection model config

- collection-scoped overrides for retrieval model roles without replacing the global preset system
- explicit resolution order so effective model URIs are predictable
- partial overrides allowed per role instead of forcing full preset duplication
- docs and diagnostics explain which collection/model combination is actually in effect

### Cross-cutting requirements

- JSON / CSV / XML / files output remain stable unless the task explicitly says otherwise
- CLI output changes must be TTY-aware and must not pollute pipes, tests, or structured output
- all new behavior must be covered by deterministic automated tests
- docs must update in the same task that changes behavior
- website docs/pages must remain in sync via `bun run website:sync-docs`

### ADR plan

This epic should add:

- `docs/adr/002-bm25-query-semantics-and-weighting.md`
- `docs/adr/003-code-aware-chunking.md`
- `docs/adr/004-collection-model-resolution.md`

Do not overload ADR-001 with retrieval/CLI behavior.

### Website plan

Expected website touchpoints across the epic:

- `website/_data/features.yml`
- `website/features/hybrid-search.md`
- `website/features/multi-format.md`
- synced docs under `website/docs/` via `bun run website:sync-docs`

If terminal output examples materially change, refresh CLI-facing website screenshots/demos only where justified by the implementation.

### Risks / design traps

- regression tests that encode today's buggy behavior instead of intended behavior
- overfitting BM25 fixes to a narrow fixture set
- code-aware chunking that improves one language but regresses markdown/prose ingestion throughput or line-range stability
- hyperlinks that leak OSC 8 codes into non-TTY output or make snapshots brittle
- doc drift between architecture/search docs and actual implementation
- `.3` and `.4` can run in parallel for code, but both want shared docs/website files; reserve doc collation for one owner or final merge window
- `.5` overlaps with config/docs and likely `README.md`; keep its doc edits out of the same merge window as `.2` if possible

### Task breakdown

#### Task 1

`fn-64-retrieval-quality-and-terminal.1`

Define the BM25 regression matrix first.

#### Task 2

`fn-64-retrieval-quality-and-terminal.2`

Change BM25 semantics only after the matrix exists.

#### Task 3

`fn-64-retrieval-quality-and-terminal.3`

Add TTY terminal hyperlinks without destabilizing structured output modes.

#### Task 4

`fn-64-retrieval-quality-and-terminal.4`

Implement code-aware chunking with fallback and retrieval validation.

#### Task 5

`fn-64-retrieval-quality-and-terminal.5`

Add per-collection model configuration with clear resolution rules.

## Quick commands

- `bun run lint:check`
- `bun test`
- `bun run docs:verify`
- `bun run website:sync-docs`
- `bun run eval:hybrid`

## Acceptance

- [ ] BM25 edge cases have a durable regression suite with deterministic fixtures.
- [ ] BM25 query building/ranking is hardened against the covered lexical/path/filter cases.
- [ ] Supported code files can chunk structurally with safe fallback to the current chunker.
- [ ] CLI retrieval output can emit clickable terminal links in TTY mode while preserving plain output elsewhere.
- [ ] Collections can override retrieval model roles with explicit, documented resolution rules layered on top of existing presets.
- [ ] Retrieval docs, architecture docs, ADRs, and website content are updated in the same epic.

## Early proof point

Task `fn-64-retrieval-quality-and-terminal.1` proves the lexical edge cases are concrete, reproducible, and protected before any behavior change lands.

If it fails to define clear intended outcomes or produces noisy/non-deterministic cases, re-evaluate the BM25 hardening scope before continuing with `fn-64-retrieval-quality-and-terminal.2+`.

## Requirement coverage

| Req | Description                                                                                      | Task(s)                                                                                                                                                                | Gap justification                                                              |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| R1  | Durable BM25 lexical regression matrix exists                                                    | `fn-64-retrieval-quality-and-terminal.1`                                                                                                                               | —                                                                              |
| R2  | BM25 lexical/path/filter semantics are hardened without query-language creep                     | `fn-64-retrieval-quality-and-terminal.2`                                                                                                                               | —                                                                              |
| R3  | CLI retrieval results support clickable TTY hyperlinks while preserving structured output safety | `fn-64-retrieval-quality-and-terminal.3`                                                                                                                               | —                                                                              |
| R4  | Supported code files chunk structurally with safe fallback and stable line ranges                | `fn-64-retrieval-quality-and-terminal.4`                                                                                                                               | —                                                                              |
| R5  | Collections can override retrieval model roles with explicit, predictable resolution rules       | `fn-64-retrieval-quality-and-terminal.5`                                                                                                                               | —                                                                              |
| R6  | Docs, ADRs, specs, and website stay in sync                                                      | `fn-64-retrieval-quality-and-terminal.2`, `fn-64-retrieval-quality-and-terminal.3`, `fn-64-retrieval-quality-and-terminal.4`, `fn-64-retrieval-quality-and-terminal.5` | Task `.1` only seeds `spec/evals.md`; behavior docs land with behavior changes |

## References

- `src/store/sqlite/adapter.ts`
- `src/store/migrations/002-documents-fts.ts`
- `src/pipeline/search.ts`
- `src/pipeline/hybrid.ts`
- `src/pipeline/types.ts`
- `src/ingestion/chunker.ts`
- `src/ingestion/sync.ts`
- `src/cli/format/search-results.ts`
- `src/config/types.ts`
- `src/llm/registry.ts`
- `src/llm/nodeLlamaCpp/adapter.ts`
- `test/store/fts.test.ts`
- `test/ingestion/chunker.test.ts`
- `test/cli/search-fixtures.test.ts`
- `test/cli/query-smoke.test.ts`
- `docs/CLI.md`
- `docs/HOW-SEARCH-WORKS.md`
- `docs/ARCHITECTURE.md`
- `docs/CONFIGURATION.md`
- `docs/TROUBLESHOOTING.md`
- `docs/GLOSSARY.md`
- `docs/API.md`
- `docs/MCP.md`
- `spec/cli.md`
- `spec/evals.md`
- `website/_data/features.yml`
- `website/features/hybrid-search.md`
- `website/features/multi-format.md`
