# Search snippet quality: skip frontmatter, prefer prose

## Problem

Search/query result snippets frequently show raw YAML frontmatter
(`---\ntags:\n  - homelab\n...`) instead of relevant document content.
Two causes, observed live while QAing the GNO Recall Omarchy plugin:

1. Chunk 0 of a markdown document includes the frontmatter block, so any
   result whose best chunk is the document head renders frontmatter as the
   snippet (`snippet = fts.snippet ?? chunk?.text` in
   `src/pipeline/search.ts`; `chunk.text` in `src/pipeline/vsearch.ts`).
2. Tags/metadata live in frontmatter, so FTS5's match-centered
   `snippet(documents_fts, ...)` actively centers on frontmatter when the
   query matches tag terms.

User: "might be useful to show more relevant content snippets of each
entry and not frontmatter."

## Fix

Display-layer snippet cleaning in the pipeline result builders (NOT
re-chunking, NO reindex):

- Shared helper (reuse/extend `src/ingestion/frontmatter.ts`): strip a
  leading YAML frontmatter fence from snippet text; trim leading blank
  lines; if the remainder is empty, fall back to the first prose lines of
  the chunk/document rather than returning an empty snippet.
- Apply in `buildSearchResult` (search.ts default branch), vsearch.ts
  snippet assignments, and hybrid.ts if it assigns snippets directly.
- Do NOT alter `--full` output or `--line-numbers` raw chunk output;
  keep `snippetRange`/`line` consistent (adjust startLine by stripped
  line count where chunk text is the source).
- All surfaces benefit (CLI, MCP, REST, web UI) since they share the
  pipeline.

## Acceptance

- For a frontmattered fixture, no default search/query snippet starts
  with a `---` fence; tag-matched queries show prose, not tag lists.
- `--full` and `--line-numbers` behavior unchanged.
- Unit tests for the helper + pipeline-level assertion; `bun test` and
  `bun run lint:check` green.

## Resolution (2026-09-27)

Closed as fixed. `63cd2aba` ("fix: strip frontmatter from search snippets, prefer prose", first shipped in v1.36.1) added `src/pipeline/snippet.ts` and wired it into search, vsearch and hybrid, with tests. Re-checked on v2.8.0: a tag-only term (`search storage`) returns a prose snippet, and no search, vsearch or query snippet starts with `---`; `--full` and `--line-numbers` still show raw frontmatter as intended.
