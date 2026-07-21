# fn-104 Project-Aware Retrieval Affinity

## Goal & Context
<!-- scope: business -->

Make retrieval naturally prefer the project an agent is working in without requiring manual collection filters. Use the caller's current workspace/repository roots as a transparent soft signal, never a hidden hard filter.

## Architecture & Data Models
<!-- scope: technical -->

Add an optional `ProjectAffinity` input containing normalized caller cwd/workspace roots and source. Resolve roots against configured collection paths and document absolute paths using realpath-safe containment. Convert matches into a bounded ranking contribution applied after base retrieval normalization and before final cutoff/rerank blending.

Expose the contribution in explain/diagnose output and request metadata. Affinity never creates candidates absent from normal retrieval and cannot overwhelm strong lexical/semantic relevance. Clients may disable or explicitly provide roots; MCP/SDK/REST cannot infer a filesystem cwd unless the caller supplies it.

## API Contracts
<!-- scope: technical -->

- CLI derives affinity from cwd/repository root by default with `--no-project-affinity` and explicit `--project-root` overrides.
- SDK/REST/MCP accept optional project roots/workspace hints through additive fields.
- Search metadata/explain identifies matched root/collection and exact score contribution without leaking unrelated absolute paths in remote responses.
- Config sets enablement and a strictly bounded maximum contribution.

## Edge Cases & Constraints
<!-- scope: technical -->

- Resolve symlinks, nested repositories, worktrees, case sensitivity, deleted roots, and overlapping collections deterministically.
- Never treat prefix strings as containment without path-segment/realpath checks.
- Unknown roots produce zero boost, not an error or global fallback.
- Affinity cannot bypass collection/tag/date/exclude/egress filters.
- Avoid exposing private absolute paths in public/remote logs or output.
- Ranking remains deterministic for identical roots and index state.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** CLI searches from inside a configured project softly prefer relevant documents from the matching collection when base relevance is comparable.
- **R2:** Stronger non-project evidence can still outrank weak project matches; adversarial tests enforce the contribution cap.
- **R3:** CLI, SDK, REST, and MCP use one affinity implementation with explicit caller-supplied semantics outside CLI.
- **R4:** Explain/diagnose output shows whether affinity matched and its bounded score effect.
- **R5:** Symlink/worktree/nested/overlap and path-privacy cases are covered without filter or egress bypass.
- **R6:** `fn-97` project-scoped tasks show improved collection choice without overall evidence-accuracy regression.

## Boundaries
<!-- scope: business -->

No automatic collection creation, hard filtering, IDE-specific extension, file watching, ranking personalization, or use of untrusted document paths as project identity.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

Agents usually work within a project. A transparent affinity signal removes repetitive filter setup while preserving discovery across the wider knowledge base.

### Implementation Tradeoffs
<!-- scope: technical -->

A capped additive signal is safer than automatic filtering. Explicit metadata and explain output keep the convenience observable rather than magical.

## Implementation Plan

1. `fn-104-project-aware-retrieval-affinity.1` — Build trusted project-root resolution and affinity metadata (**M**)
2. `fn-104-project-aware-retrieval-affinity.2` — Apply one bounded explainable affinity score (**M**); depends on `fn-104-project-aware-retrieval-affinity.1`
3. `fn-104-project-aware-retrieval-affinity.3` — Expose explicit affinity inputs across CLI SDK REST and MCP (**M**); depends on `fn-104-project-aware-retrieval-affinity.2`
4. `fn-104-project-aware-retrieval-affinity.4` — Gate affinity with agentic evals schemas and documentation (**M**); depends on `fn-104-project-aware-retrieval-affinity.3`

## Quick commands

```bash
bun test test/core/project-affinity* test/pipeline/project-affinity*
bun run eval:agentic
.flow/bin/flowctl validate --spec fn-104-project-aware-retrieval-affinity --json
```

## References

- `src/core/validation.ts` — path containment safety.
- `src/pipeline/search.ts:39-153` — BM25 score normalization.
- `src/pipeline/hybrid.ts:659-760` — shared final scoring seam.

## Early proof point

Task `fn-104-project-aware-retrieval-affinity.1` validates the core approach (realpath-safe root matching identifies a configured collection without leaking or hard-filtering unrelated evidence).
If it fails, re-evaluate the project-root identity and caller trust boundary before continuing with `fn-104-project-aware-retrieval-affinity.2`+.

## Requirement coverage

| Req | Description | Task(s) | Gap justification |
|-----|-------------|---------|-------------------|
| R1 | CLI searches from inside a configured project softly prefer relevant documents from the matching collection when base relevance is comparable. | fn-104-project-aware-retrieval-affinity.1, fn-104-project-aware-retrieval-affinity.2 | — |
| R2 | Stronger non-project evidence can still outrank weak project matches; adversarial tests enforce the contribution cap. | fn-104-project-aware-retrieval-affinity.2, fn-104-project-aware-retrieval-affinity.4 | — |
| R3 | CLI, SDK, REST, and MCP use one affinity implementation with explicit caller-supplied semantics outside CLI. | fn-104-project-aware-retrieval-affinity.1, fn-104-project-aware-retrieval-affinity.3, fn-104-project-aware-retrieval-affinity.4 | — |
| R4 | Explain/diagnose output shows whether affinity matched and its bounded score effect. | fn-104-project-aware-retrieval-affinity.2, fn-104-project-aware-retrieval-affinity.3, fn-104-project-aware-retrieval-affinity.4 | — |
| R5 | Symlink/worktree/nested/overlap and path-privacy cases are covered without filter or egress bypass. | fn-104-project-aware-retrieval-affinity.1, fn-104-project-aware-retrieval-affinity.2, fn-104-project-aware-retrieval-affinity.3, fn-104-project-aware-retrieval-affinity.4 | — |
| R6 | `fn-97` project-scoped tasks show improved collection choice without overall evidence-accuracy regression. | fn-104-project-aware-retrieval-affinity.4 | — |
