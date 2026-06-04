# Typed graph traversal and retrieval diagnostics

## Goal & Context

Make GNO’s graph useful for reasoning and debugging, not only visualization or optional retrieval expansion. Add typed edge extraction, graph traversal commands, and targeted retrieval diagnostics for named things.

Inspiration: `garrytan/gbrain` cloned at `/tmp/gbrain`, especially `graph-query`, typed edges, search diagnose, named-thing retrieval evidence, and graph-aware retrieval docs. Use as inspiration only; do not copy code verbatim.

## Architecture & Data Models

Extend the current link model to carry optional edge metadata:

- `linkType`: `mentions`, `related`, `attended`, `works_at`, `founded`, `advises`, `source`, `decision_for`, etc.
- `confidence`: parsed|inferred|manual.
- `source`: wikilink, markdown link, frontmatter relation, explicit syntax.

Start deterministic:

- Wiki links and markdown links default to `mentions`/`related`.
- Frontmatter relations can define typed links:

```yaml
relations:
  works_at:
    - gno://notes/companies/acme.md
  attended:
    - gno://notes/meetings/2026-06-04-sync.md
```

- Optional typed-link Markdown convention can be documented later if needed.

Add traversal surfaces:

```bash
gno graph query <doc> --type mentions --depth 2 --direction both --json
gno links list <doc> --type works_at --json
gno backlinks <doc> --type attended
```

Add targeted retrieval diagnosis:

```bash
gno query diagnose "Alice Acme" --target gno://notes/people/alice.md --json
```

Diagnostic output should show which retrieval layers found or missed the target: BM25, vector, hybrid fusion, graph expansion, rerank, filters, type/category/date filters, and explain whether line/chunk choice caused a miss.

## API Contracts

- CLI: `gno graph query`, `gno query diagnose`.
- REST: `POST /api/graph/query`, `POST /api/query/diagnose`.
- MCP: read-only `gno_graph_query` and `gno_query_diagnose`.
- Output schemas added under `spec/output-schemas/`.

## Edge Cases & Constraints

- Existing untyped links must continue to work.
- Type filters must degrade cleanly when no typed graph data exists.
- Graph query must cap depth/node count to avoid runaway traversal.
- Diagnostics must not require embeddings to explain BM25-only behavior.
- Diagnostics should be deterministic enough for regression tests.
- Graph expansion remains opt-in for normal query paths unless explicitly changed in a future spec.

## Acceptance Criteria

- [ ] Store and retrieve typed link metadata without breaking existing link/backlink APIs.
- [ ] Frontmatter relations create typed edges during indexing.
- [ ] `gno graph query` supports depth, direction, type, JSON, and safe limits.
- [ ] `gno query diagnose --target` explains target hit/miss across retrieval stages.
- [ ] MCP/API/spec schemas and docs are updated.
- [ ] Regression tests cover typed edges, traversal limits, and named-target diagnostics.

## Documentation Requirement

Every implementation task from this spec must update all relevant GNO documentation surfaces in the same change set: repo docs/specs, CLI/MCP/API references, skill assets where applicable, and the hosted website repo at `/Users/gordon/work/gno.sh`. Do not mark the spec or a user-facing task complete while hosted website docs remain stale.

## Boundaries

- No LLM-based entity extraction in this spec.
- No automatic relationship inference beyond deterministic frontmatter/link rules.
- No default graph expansion behavior change.

## Decision Context

GNO already shipped graph-aware retrieval as opt-in. The next improvement is observability and typed traversal so agents can ask relationship questions and developers can debug why important pages do or do not surface.
