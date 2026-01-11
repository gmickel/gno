# T13.5: Semantic search command

**Migrated from:** gno-ub9.13
**Priority:** P2

## Description

Implement semantic/hybrid search command.

## File

src/semantic-search.tsx

## Trigger Keywords

semantic search, similar notes, query

## Component

List with search

## Backend

CLI (gnoQuery) or API (apiQuery)

## Differences from BM25 Search

- Uses vector similarity + BM25 hybrid
- May be slower (embedding computation)
- Better for conceptual queries

## Implementation

Similar to search.tsx but uses gnoQuery/apiQuery

## Checklist

- [ ] List component with search
- [ ] Use gnoQuery for hybrid search
- [ ] Fallback handling if embeddings not available
- [ ] Loading state (may be slower)
- [ ] Actions: Open, ShowInFinder, CopyPath

## Acceptance Criteria

- [ ] Implementation complete
- [ ] Tests passing
