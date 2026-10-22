---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R8]
---
# fn-224-gno-ls-filter-list-documents-by-typed.1 Implement gno ls --filter: list documents by typed metadata

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
`gno ls --filter <json>` and SDK `list({ filter })` list documents whose typed metadata matches, using search's evaluator (`typedMetadataFilterReason`) through a new shared `filterDocumentsByMetadata`, applied before pagination. Skipped invalid/pending documents produce `METADATA_COVERAGE_INCOMPLETE` in `meta.warnings` (stderr for non-JSON formats). Invalid predicates give search's VALIDATION error. New `ls@1.0` schema + contract test; spec/cli.md documents the real `{documents, meta}` shape. Docs: CLI.md, SDK.md, TYPED-METADATA.md, CHANGELOG. Skill: Retrieve row, filter guidance, cli-reference `gno ls`, examples "List by metadata", and the four bare-array jq examples fixed. Autoresearch eval: list_by_metadata + ls_json_export added; 100% (56/56) with the new skill, 94.6% with main's.

Tests: test/cli/ls-filter.test.ts (8) fails 6/7 on main, passes on branch; full suite 6360 pass / 0 fail.

stage: impl-review - skipped(policy: repo CLAUDE.md skips all review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 5c735e4c
- Tests: bun test test/cli/ls-filter.test.ts test/spec/schemas/ls.test.ts, bun test, uv run eval.py (autoresearch gno-skill, 100%)
- PRs: