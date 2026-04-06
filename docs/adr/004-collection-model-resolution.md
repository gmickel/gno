# ADR-004: Collection Model Resolution

**Status**: accepted
**Date**: 2026-04-06
**Author**: Gordon Mickel

## Context

GNO already has a global preset system for embedding, reranking, expansion, and answer generation.

That works well for most users, but some workspaces need one collection to use a different retrieval stack than the rest:

- code-heavy docs vs prose-heavy docs
- local CPU-friendly defaults vs a heavier collection
- incremental experimentation without replacing the whole active preset

The project should support that without forcing users to duplicate an entire preset for one collection or inventing a second config file format.

## Decision

Add optional collection-scoped model overrides inside the existing central config file.

Resolution order:

1. collection role override
2. active preset role
3. built-in default fallback

Overrides are partial by role. A collection can override only `rerank`, for example, while inheriting `embed`, `expand`, and `gen` from the active preset.

## Consequences

### Positive

- collection-specific retrieval tuning without replacing the whole preset system
- less duplication than creating per-collection presets
- clearer mental model than adding config files inside collection roots

### Negative

- model resolution is no longer purely “active preset only”
- collection-aware operations must pass the collection name into model resolution explicitly
- cross-collection operations still need careful handling when multiple collections could imply different model choices

## Notes

- This ADR covers model resolution only.
- It does not imply per-collection chunking strategy, per-collection runtime shells, or per-folder config files.
