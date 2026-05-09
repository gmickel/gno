# Scoped code-symbol graph foundation

## Description

Plan and, if justified by prior graph-aware retrieval results, implement a narrow code-symbol graph foundation that complements document retrieval without turning GNO into a full static-analysis engine.

The scope should stay small: supported languages only, document nodes remain primary, symbol nodes are optional/derived, and unsupported languages or parser failures fall back cleanly. This task should coordinate with existing future code-symbol retrieval work instead of duplicating it.

Docs, Web UI updates when affected, and hosted website updates are part of this task if any user-facing behavior ships, including `~/work/gno.sh` content.

## Implementation Notes

Before implementing, reconcile with `fn-76-future-code-symbol-retrieval-and` and any completed AST/code retrieval work. This task should not duplicate or bypass that prior plan.

Default posture:

- Document nodes remain the primary graph nodes.
- Symbol nodes are optional derived metadata.
- Supported languages should be deliberately small at first.
- Parser failures and unsupported languages must fall back without breaking indexing.
- No full LSP/static-analysis engine.

Expected deliverable is either a narrow implementation backed by tests or a written decision/follow-up spec explaining why code-symbol graph work should stay future.

Testing focus if implemented:

- Supported language extraction.
- Unsupported language fallback.
- Parser failure fallback.
- Relationship to document graph output.
- MCP/CLI/Web behavior only if symbol graph surfaces are exposed.

## Acceptance

- The task explicitly reconciles with the existing future code-symbol retrieval epic before implementation begins.
- Any shipped code-symbol graph support is scoped to a small supported-language set and remains optional/derived from indexed documents.
- Symbol graph data does not destabilize document graph retrieval or existing graph consumers.
- Tests cover supported-language extraction, unsupported-language fallback, parser failure fallback, and MCP/CLI behavior if exposed.
- If no implementation ships, the task produces a concrete follow-up decision/spec with evidence from earlier graph-aware retrieval work.
- User-facing docs, affected Web UI surfaces, and hosted website content in `~/work/gno.sh` are updated where applicable.
- Quality gates include targeted tests or decision evidence, `bun run lint:check`, `bun test` where feasible, docs verification, and website sync/check commands relevant to changed docs.

## Done summary

_To be completed when the task is implemented._

## Evidence

_To be completed when the task is implemented._
