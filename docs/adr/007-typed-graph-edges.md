# ADR-007: Typed Graph Edges

**Status**: accepted
**Date**: 2026-06-06
**Author**: Gordon Mickel

## Context

GNO already stores positional `doc_links` for wiki and markdown syntax and builds
a graph from those links at query time. Typed traversal and retrieval diagnostics
need a semantic relationship layer (`mentions`, `works_at`, `attended`, etc.)
without changing the existing `linkType: wiki|markdown` contracts.

The link resolver used by `getGraph()` also has path/title fallback behavior that
future backfill must match exactly. Duplicating that resolver would make graph
query output and typed-edge projection diverge.

## Decision

Add a derived `doc_edges` table for semantic relationships. Keep these axes
separate:

- `doc_links.link_type`: how the link was written (`wiki` or `markdown`).
- `GraphLinkType`: existing graph projection kind (`wiki`, `markdown`,
  `similar`).
- `doc_edges.edge_type`: semantic relationship, stored as a free-form validated
  lowercase snake_case string.

`doc_edges` keeps `UNIQUE(src_doc_id, dst_doc_id, edge_type, source)` so multiple
provenance sources can coexist. Reads deduplicate by `(src_doc_id, dst_doc_id,
edge_type)` using confidence precedence `manual > configured > parsed >
inferred`.

The table stores resolved document ids as a derived cache. Since document removal
is normally a soft delete (`documents.active = 0`), reads always join active
source and target documents. Reprojection/backfill rebuilds link-derived edges
from current documents and `doc_links`.

The backfill path reuses the shared resolver helpers extracted for `getGraph()`
in `src/core/graph-resolver.ts`. It does not copy resolver SQL inline.

## Consequences

Existing link, backlink, graph, and schema contracts stay backward compatible.
Typed-edge readers can evolve independently and power bounded traversal,
diagnostics, REST, MCP, and future filters.

The derived cache must be refreshed after changes that affect link resolution or
relationship derivation. Future ingestion work wires this into the post-upsert
projection pass and adds frontmatter `relations:` and `graphHints` derivation.
