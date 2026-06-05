# Typed graph traversal and retrieval diagnostics

## Goal & Context

Make GNO's graph useful for reasoning and debugging, not only visualization or optional retrieval expansion. Add deterministic typed edge extraction, graph traversal commands, and targeted retrieval diagnostics for named things.

This spec follows GNO-1 / `fn-83` as implemented in `v1.9.0`: second-brain presets, opt-in `contentTypes`, `contentType`/`categories` search exposure, `contentTypeSource`, and `contentTypeRulesFingerprint` now exist and must be reused rather than reinvented.

Inspiration: `garrytan/gbrain` cloned at `/tmp/gbrain`, especially `graph-query`, typed edges, search diagnose, named-thing retrieval evidence, and graph-aware retrieval docs. Use as inspiration only; do not copy code verbatim.

## Shipped Substrate From GNO-1

GNO-1 added the typing/config/search base this spec should build on:

- `contentTypes[]` config is optional and defaults to legacy behavior.
- `graphHints` is accepted on each content type and reserved for this spec. Current vocabulary: `mentions`, `works_at`, `attended`, `decided`, `related_to`.
- `searchBoost` remains reserved for future ranking and stays out of this spec unless diagnostics only report it as a no-op.
- Search/query results expose `contentType` and `categories` on JSON/schema surfaces.
- Ingestion derives `contentType` with a visible `contentTypeSource`: `frontmatter-type`, `prefix`, `path-ext`, or `fallback`.
- Sync stores a `contentTypeRulesFingerprint` so config edits re-derive metadata for unchanged files.
- Presets stay flat (`type`, `category`, `tags`); provenance remains handled by the capture path. Do not require nested preset frontmatter.

## Architecture & Data Models

Do not overload the current `linkType` field. Existing link storage uses `linkType` for syntax/source kind (`wiki` or `markdown`). This spec adds relationship semantics separately:

- `edgeType` or `relationType`: `mentions`, `related_to`, `attended`, `works_at`, `decided`, `founded`, `advises`, `source`, `decision_for`, etc.
- `confidence`: `parsed`, `configured`, `manual`, or `inferred`.
- `source`: `wikilink`, `markdown-link`, `frontmatter-relation`, `contentType-graphHint`, or future explicit syntax.
- Existing `linkType` remains the syntax discriminator: `wiki` or `markdown`.

Start deterministic and additive:

- Wiki links and markdown links remain stored as existing untyped links and may be projected as `mentions` or `related_to` semantic edges for traversal.
- `contentTypes[].graphHints` provides default semantic edges or traversal hints for documents of that content type; it must not mutate user files.
- Frontmatter relations can define typed edges without changing preset serialization:

```yaml
relations:
  works_at:
    - gno://notes/companies/acme.md
  attended:
    - gno://notes/meetings/2026-06-04-sync.md
```

- Optional typed-link Markdown syntax is deferred unless a later task proves it is necessary.

Graph storage can either extend `doc_links` with nullable semantic columns or introduce a derived edge table. Whichever path is chosen must preserve existing `gno links`, `gno backlinks`, REST link routes, MCP link tools, and graph visualization behavior for old data.

## Traversal Surfaces

Add traversal surfaces while aligning command names with current CLI/API conventions:

```bash
gno graph query <doc> --edge-type mentions --depth 2 --direction both --json
gno links <doc> --edge-type works_at --json
gno backlinks <doc> --edge-type attended --json
```

Notes:

- `gno links <doc>` is the existing command shape; do not introduce `gno links list` unless the CLI is intentionally reorganized.
- `--type` is ambiguous with existing link syntax and content type. Prefer `--edge-type` or `--relation` for relationship filtering.
- Direction values: `out`, `in`, `both`.
- Depth and node/edge limits are mandatory to avoid runaway traversal.

## Targeted Retrieval Diagnosis

Add targeted retrieval diagnosis:

```bash
gno query diagnose "Alice Acme" --target gno://notes/people/alice.md --json
```

Diagnostic output should show which retrieval layers found or missed the target:

- BM25 stage.
- Vector stage, when embeddings are available.
- Hybrid fusion.
- Graph expansion, when explicitly requested or used by the diagnostic.
- Rerank, when enabled.
- Filters: collection, tag, category, `contentType`, date, author.
- Typed metadata: `contentType`, `contentTypeSource`, categories, `contentTypeRulesFingerprint` match/mismatch.
- Chunk/line explanation: whether the target document was found but the wrong chunk/line was selected.

Diagnostics must remain useful without embeddings: BM25-only and metadata-only explanations are valid.

## API Contracts

- CLI: `gno graph query`, `gno query diagnose`; optional `--edge-type` filters on existing `gno links`/`gno backlinks` if the data model supports it cleanly.
- REST: `POST /api/graph/query`, `POST /api/query/diagnose`.
- MCP: read-only `gno_graph_query` and `gno_query_diagnose`.
- Output schemas added under `spec/output-schemas/`.
- Existing `gno_links`, `gno_backlinks`, and graph MCP tools remain backward compatible.

## Edge Cases & Constraints

- Existing untyped links must continue to work.
- Existing `linkType: wiki|markdown` API/schema fields must remain backward compatible.
- Relationship filters must degrade cleanly when no typed graph data exists.
- `contentTypes[].graphHints` must be honored only as additive graph hints, not as ranking changes.
- Graph query must cap depth/node/edge count to avoid runaway traversal.
- Diagnostics must not require embeddings to explain BM25-only behavior.
- Diagnostics should be deterministic enough for regression tests.
- Graph expansion remains opt-in for normal query paths unless explicitly changed in a future spec.

## Acceptance Criteria

- [ ] Store and retrieve relationship semantics (`edgeType`/`relationType`, confidence, source) without breaking existing `linkType: wiki|markdown` APIs.
- [ ] Frontmatter `relations:` create typed edges during indexing.
- [ ] `contentTypes[].graphHints` are consumed as additive graph hints for traversal/diagnostics and remain no-op for ranking.
- [ ] `gno graph query` supports depth, direction, edge-type filtering, JSON, and safe limits.
- [ ] Existing `gno links` / `gno backlinks` continue to work and optionally accept relationship filters without command-shape regression.
- [ ] `gno query diagnose --target` explains target hit/miss across retrieval stages, including `contentType`, `contentTypeSource`, categories, filters, and chunk/line choice.
- [ ] MCP/API/spec schemas and docs are updated.
- [ ] Regression tests cover typed edges, graphHints consumption, traversal limits, backward compatibility, and named-target diagnostics.

## Documentation Requirement

Every implementation task from this spec must update all relevant GNO documentation surfaces in the same change set: repo docs/specs, CLI/MCP/API references, skill assets where applicable, and the hosted website repo at `/Users/gordon/work/gno.sh`. Do not mark the spec or a user-facing task complete while hosted website docs remain stale.

## Boundaries

- No LLM-based entity extraction in this spec.
- No automatic relationship inference beyond deterministic frontmatter/link/config rules.
- No default graph expansion behavior change.
- No ranking behavior change from `searchBoost`.
- No nested preset-frontmatter serializer work; GNO-1 flat preset behavior remains.
- No task breakdown in this spec update; `/flow-next:plan` will split work later.

## Decision Context

GNO-1 shipped the second-brain typing substrate. The next improvement is observability and typed traversal: agents need relationship questions to be explicit and developers need diagnostics that explain why important typed pages do or do not surface. This spec should reuse the shipped `contentTypes` and graph-hint vocabulary, while keeping syntax-level links (`wiki`/`markdown`) separate from semantic relationships.
