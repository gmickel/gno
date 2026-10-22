# gno ls --filter: list documents by typed metadata

## Conversation Evidence

> user (turn 2): "plus the clean parts of the mixed ones (#315 ls --filter; #318 the 500-to-403 fix)"
> user (turn 2): "reference the original PR(s) and say it supersedes them"
> user (turn 2): "leave out ... the ... derived_from convention, permission-boundary framing, the raised egress caps"
> user (turn 3): "Just say the spec supersedes the referenced PR(s) and uses them as reference for the intended outcome."

## Goal & Context
<!-- scope: business -->

<!-- Source: 10% user / 30% [paraphrase] / 60% [inferred] -->

This spec supersedes the `gno ls --filter` part of #315 and uses it as reference for the intended outcome. The provenance convention #315 also documents is not part of this spec. Its CHANGELOG entry credits @ArnauvGilotra for the idea and the original pull request.

Typed metadata predicates (`gno.metadata`) already filter `search`, `query`, `ask` and Context Capsules. `gno metadata` shows which keys and values exist, but nothing lists the documents that match a predicate without running a search. Examples: every note with `status: draft`, or every note whose `project` list contains `atlas`. `gno ls --filter <json>` adds that listing with the same predicate semantics as search.

## Architecture & Data Models
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

- `ls` applies the predicate with the same evaluator search uses. A document with invalid or not-yet-extracted typed metadata never matches, including under negated predicates.
- The filter runs before pagination, so `limit`, `offset` and `meta.total` count matching documents only.
- When documents were left out because their metadata is invalid or still pending extraction, `ls` reports it the way search does, through the existing metadata-coverage warning codes.
- The SDK's document listing takes the same `filter` option.

## API Contracts
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

```bash
gno ls [<scope>] [--filter <json>] [-n <num>] [--offset <num>] [--json|--files|--md]
```

`--json` output (now covered by `spec/output-schemas/ls.schema.json`):

```json
{
  "documents": [
    { "docid": "#a1b2c3d4", "uri": "gno://work/doc.md", "title": "Doc", "source": { "relPath": "doc.md", "mime": "text/markdown", "ext": ".md" } }
  ],
  "meta": {
    "total": 12, "returned": 1, "offset": 0,
    "warnings": [{ "code": "METADATA_COVERAGE_INCOMPLETE", "message": "…" }]
  }
}
```

`meta.warnings` appears only when `--filter` is given and coverage is incomplete. In terminal formats the warning goes to stderr.

Errors: invalid JSON or an invalid predicate gives the same `VALIDATION` error, exit 1, as `gno search --filter`.

## Edge Cases & Constraints
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

- Without `--filter`, `ls` output is unchanged in every format.
- `--filter` combines with the scope argument (collection or `gno://` prefix): both must hold.
- `spec/cli.md` currently documents `ls --json` as a bare array while the command returns `{documents, meta}`. The spec and the new schema describe the actual shape.
- Docs: `spec/cli.md`, the `ls` schema and its contract test, `docs/CLI.md`, `docs/TYPED-METADATA.md` (a "listing by metadata" section using neutral example keys), `docs/SDK.md`, CHANGELOG and the hosted gno.sh docs ship with the change. Skill and agent-instruction changes are listed in the next section.

## Skill and Agent Instructions
<!-- scope: technical -->

<!-- Source: 100% [inferred] -->

Agents learn `ls --filter` only from the shipped skill, so the skill changes and its eval are part of this spec.

- `assets/skill/SKILL.md`: the **Retrieve** row of the command table names `ls --filter`, and the filter guidance says that enumerating documents by typed metadata with no query (every `status: draft` note) uses `gno ls [<collection>] --filter '<json>'`, not a search with a placeholder query.
- `assets/skill/cli-reference.md`, `### gno ls`: the `--filter <json>` flag, its shared predicate syntax with `search --filter`, the `{documents, meta}` JSON shape, and `meta.warnings` for incomplete coverage.
- `assets/skill/examples.md`: a "List by metadata" example under "List documents". Fix the existing JSON examples that read the output as a bare array: `ls --json | jq -r '.[].docid'` (line 227) becomes `.documents[].docid`, and the three `search --json | jq '.[] …'` examples (lines 207, 210, 230) become `.results[]`. They fail against the real output today.
- `assets/skill/mcp-reference.md`: no change. This spec adds no MCP listing.
- Autoresearch eval (`~/repos/autoresearch-experiments/gno-skill/eval.py`), two new scenarios:
  - `list_by_metadata`: "List every note in my work collection whose status is draft. I don't have a search term." Checks: `gno\s+ls`, `--filter`, `status`; must not use `gno\s+(search|query|vsearch)`.
  - `ls_json_export`: "Write the docids of every document in work to a file, using jq." Checks: `gno\s+ls`, `\.documents\[\]`; must not match `jq -r '\.\[\]`.
  Iterate `skill.md` until the full suite scores 100%, copy the winner back to `assets/skill/` and reinstall (repo CLAUDE.md, "Skill & MCP Optimization").
- Retrieval ladder (`src/cli/commands/agents/block.ts`, `docs/AGENT-INSTRUCTIONS.md`): no change, and `BLOCK_VERSION` stays. Listing by metadata enumerates documents rather than answering a question, and the block already sends filters to the skill. The global ladder in `~/work/agent-instructions` needs no change for the same reason.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** `gno ls --filter <json>` lists exactly the active documents whose typed metadata satisfies the predicate, using the same semantics as `gno search --filter`. Errors: invalid JSON or predicate → `VALIDATION`, exit 1, same message as search. [paraphrase]
- **R2:** Documents with invalid or not-yet-extracted typed metadata never match, including under negated predicates. When any are skipped, JSON output carries `meta.warnings` with the existing coverage code, and terminal output prints it on stderr. [inferred] Errors: no error surface beyond R1.
- **R3:** Pagination and `meta.total` count matching documents only: with 30 matches, `-n 10 --offset 20` returns the last 10 and `meta.total` is 30. [inferred] Errors: no error surface beyond R1.
- **R4:** Without `--filter`, `ls` output is byte-identical to the pre-change output in every format. [paraphrase] Errors: none.
- **R5:** `ls --json` output validates against a new `ls` output schema, and `spec/cli.md` documents the actual `{documents, meta}` shape. [inferred] Errors: none.
- **R6:** The SDK document listing accepts the same `filter` and returns the same documents and total as the CLI. [inferred] Errors: as R1, as a typed error.
- **R7:** The shipped skill documents `ls --filter` and the `{documents, meta}` shape, and every `ls --json` and `search --json` jq example in `assets/skill/` parses the real output: run against a fixture index, each example exits 0 and prints at least one value. [inferred] Errors: none.
- **R8:** The autoresearch eval, with the `list_by_metadata` and `ls_json_export` scenarios added, scores 100%, and the passing skill is the one in `assets/skill/`. The ladder block and its `BLOCK_VERSION` are unchanged. [inferred] Errors: a score below 100% blocks the PR.

## Boundaries
<!-- scope: business -->

- No documented provenance or source-reference convention for typed metadata. Docs examples use neutral keys. [paraphrase]
- No other `ls` filters (tags, dates, category, author) in this spec. [inferred]
- No REST or MCP listing changes. [inferred]

## Decision Context
<!-- scope: both — conditionally substructured -->

The intended outcome follows #315's `--filter`: the search predicate reused for `ls`, applied before pagination. These changes from #315 are deliberate: [inferred]

- **Provenance convention removed.** #315 documented `gno.metadata.derived_from` as a list of `<system>:<reference>` strings. GNO already has one provenance model, structured `source:` frontmatter, and its own spec rules out a second competing one. Whether GNO should record several sources per note is an open product question, recorded with the other multi-user gateway decisions (fn-227, D4). `ls --filter` works on any typed key either way.
- **Coverage warning added.** #315 dropped documents with pending or invalid metadata silently. Search warns in that case, and a listing that silently under-reports would mislead.
- **SDK parity added.** The SDK has its own document listing. Leaving it without `filter` would create a CLI-only capability with no reason.

## Strategy Alignment

- Local knowledge lifecycle: listing by typed metadata supports maintaining notes at scale. [strategy:Local knowledge lifecycle]
- Coherent agent and application surfaces: one predicate contract across search, ls and SDK. [strategy:Coherent agent and application surfaces]
