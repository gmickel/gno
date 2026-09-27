---
satisfies: [R1, R2, R3, R4, R5]
---
# fn-195-audit-links-ignore-code-spans-and-non.1 Implement Audit links: ignore code spans and non-Markdown sources, classify Markdown links to unindexed files

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
`gno audit links` no longer reports link-shaped text in code or in non-Markdown files, and a relative Markdown link to an existing unindexed file is an informational `links.outside-index` finding. On the synthetic vault, unresolved findings drop from 9 (v2.8.1) to 3; the 3 left are the unclosed multi-line wiki link and two genuinely missing targets.

- R1: the confirmed cause was not a missing `codeContextReason` check. The audit reads stored `doc_links`, and ingest already skipped excluded ranges. The code-span pairing in `src/ingestion/strip.ts` was the problem: it paired backtick runs across the whole note, so a stray backtick in an earlier paragraph or list item took the span's opener, and it also treated a backslash before a closing backtick as an escape. Spans now pair only within one block (paragraph, heading, list item, table row), a backslash only escapes an opener, and indented code blocks are excluded (indented list continuations stay prose). The refactor inventory maps `indented_code` to `code_fence_context`. Tests: `test/core/links.test.ts` ("Obsidian parity", 6 table cases, 4 red on base).
- R2: `src/ingestion/sync.ts` extracts links only when the converter is `native/markdown` (`MARKDOWN_CONVERTER_ID`). Plain text, code, data and converted documents store no links and stay searchable. `INGEST_VERSION` 9 re-extracts once. Test: `test/ingestion/sync-links.test.ts` ("non-Markdown sources carry no links...", includes the upgrade re-extraction; red on base with 4 edges).
- R3: `markOutsideIndexLinks` (`src/core/audit-outside-index.ts`) also checks unresolved Markdown links. It places the collection-relative target in the same workspace and matches the exact path, NFC and case-insensitive, against the same single listing: existence only, no edge, nothing opened. Link audit rule version 1.3.
- R4: the fixture test in `test/audit/link-workspace-audit.test.ts` ("residual link noise") covers a code span after a stray backtick, a fenced block, a Python file in a `**/*` collection, a Markdown link to an unindexed `.sh` beside a note, an unclosed multi-line wiki link and missing targets. It is red on base with 4 extra findings.
- R5: docs updated in CONFIGURATION, CLI, ARCHITECTURE, MCP, spec/cli.md, the skill (mirrors synced) and CHANGELOG [Unreleased] Fixed. gno.sh branch `fn-195-audit-residual` (b1cd875).
- Live QA (`.flow/tmp/qa-fn-195-audit-links-ignore-code-spans-and-non/summary.json`): on an index built and embedded by v2.8.1, the first branch `gno update` re-processed 4 docs, and `embeddingBacklog` stayed 0 (4 chunks). A fresh index gives identical findings. `gno search` still finds render.py, and `gno links` shows 0 links for it.

Follow-ups, not built:
- The change-journal link summary (`extractDocumentStructure`) still parses links in non-Markdown documents; it creates no edges or findings.
- A Markdown link without an extension to an unindexed note (`[x](Note)`) is matched by exact path only.

stage: impl-review - skipped(config: user instruction, no model review)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 416bd97a459999b0779a98cd41eb0ce215cc8400
- Tests: baseline: none (spec defines no Quick commands; base behaviour checked red-first in a detached base worktree), mise exec bun@1.4.2 -- bun test (5954 pass, 3 skip, 1 fail: test/store/links.test.ts 'skips community detection for large returned graphs' 5s timeout under full-suite load; file re-run in isolation 43 pass, 0 fail; test inserts docs directly and does not touch parser/sync), mise exec bun@1.4.2 -- bun run lint:check (0 errors, 45 pre-existing warnings), mise exec bun@1.4.2 -- bun run docs:verify, red-first: new R1/R2/R4 tests fail on base f99c2ff8 (4 R1 cases, R2 4 edges, R4 4 extra findings), live QA: gno audit links --json --max-findings all before (origin/main 8e304638, v2.8.1) and after on synthetic vault; .flow/tmp/qa-fn-195-audit-links-ignore-code-spans-and-non/summary.json, skill eval (copy at ~/.cache/gno-skill-eval-195): uv run eval.py -> 100.0 (47/47), gno.sh fn-195-audit-residual b1cd875: bun run check && bun run typecheck && bun run test (431 pass, 41 skip)
- PRs: