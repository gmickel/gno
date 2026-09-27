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

- R1: this was not a missing `codeContextReason` check. The audit reads stored `doc_links`, and ingest already skipped excluded ranges; the code detection in `src/ingestion/strip.ts` was the problem. The first commit hand-rolled the block rules, and review found two regressions: a code span across blockquote lines, and a list paragraph after a two-space continuation. Commit 1a20cb77 replaces that code with the mdast-util-from-markdown + GFM parser the repo already ships (inline code, fenced and indented code; frontmatter is blanked first). A cheap superset gate skips the parser for notes with no possible code; it had 0 misses on 1,388 real Markdown files. Sync computes the ranges once per document. Measured cost: lexical sync of 1000 notes of about 3.5 KB (1/3 with code) went from about 3.5 s to about 4.3 s, and embedding is unaffected. Tests: `test/core/links.test.ts` ("Obsidian parity", 10 cases, including both review cases, a list inside a blockquote and indented code after a heading).
- R2: `src/ingestion/sync.ts` extracts links only when the converter is `native/markdown` (`MARKDOWN_CONVERTER_ID`). Plain text, code, data and converted documents store no links and stay searchable. `INGEST_VERSION` 9 re-extracts once. Test: `test/ingestion/sync-links.test.ts` ("non-Markdown sources carry no links...", includes the upgrade re-extraction; red on base with 4 edges).
- R3: `markOutsideIndexLinks` (`src/core/audit-outside-index.ts`) also checks unresolved Markdown links. It places the collection-relative target in the same workspace and matches the exact path, NFC and case-insensitive, against the same single listing: existence only, no edge, nothing opened. Link audit rule version 1.3.
- R4: the fixture test in `test/audit/link-workspace-audit.test.ts` ("residual link noise") covers a code span after a stray backtick, a fenced block, a Python file in a `**/*` collection, a Markdown link to an unindexed `.sh` beside a note, an unclosed multi-line wiki link and missing targets. It is red on base with 4 extra findings.
- R5: docs updated in CONFIGURATION, CLI, ARCHITECTURE, MCP, spec/cli.md, the skill (mirrors synced) and CHANGELOG [Unreleased] Fixed. gno.sh branch `fn-195-audit-residual` (b1cd875).
- Live QA, re-run after the review fix (`.flow/tmp/qa-fn-195-audit-links-ignore-code-spans-and-non/round2/summary.json`): on an index built and embedded by v2.8.1, the first branch `gno update` re-processed 4 docs, and `embeddingBacklog` stayed 0 (4 chunks). A fresh index gives identical findings. `gno search` still finds render.py, and `gno links` shows 0 links for it.

Follow-ups, not built:
- The change-journal link summary (`extractDocumentStructure`) still parses links in non-Markdown documents; it creates no edges or findings.
- A Markdown link without an extension to an unindexed note (`[x](Note)`) is matched by exact path only.

stage: impl-review - ran (codex, coordinator-dispatched): NEEDS_WORK (2 P2 regressions in strip.ts), fixed in 1a20cb77

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 416bd97a459999b0779a98cd41eb0ce215cc8400, 1a20cb77d46a860cbce8e04c374bba93131916c1
- Tests: baseline: none (spec defines no Quick commands; base behaviour checked red-first in a detached base worktree), mise exec bun@1.4.2 -- bun test (5959 pass, 3 skip, 0 fail) after review fix 1a20cb77, mise exec bun@1.4.2 -- bun run lint:check (0 errors, 45 pre-existing warnings), mise exec bun@1.4.2 -- bun run docs:verify, red-first: R1/R2/R4 tests fail on base f99c2ff8; review regression tests (blockquote code span, list paragraph after continuation, list inside blockquote) fail on 416bd97a, gate superset check: parser-gated getExcludedRanges vs ungated mdast parse on 1,388 real Markdown files: 0 misses, ingest timing (1000 notes x ~3.5 KB, 1/3 with code): lexical sync 3.4-3.6 s at 416bd97a vs 4.1-4.6 s at 1a20cb77, live QA round 2: before (origin/main v2.8.1) 9 unresolved; after upgrade first gno update 3 unresolved / 1 outside-index, embeddingBacklog 0 of 4 chunks; fresh 3 / 1; .flow/tmp/qa-fn-195-audit-links-ignore-code-spans-and-non/round2/summary.json, skill eval (copy at ~/.cache/gno-skill-eval-195): uv run eval.py -> 100.0 (47/47), gno.sh fn-195-audit-residual b1cd875: bun run check && bun run typecheck && bun run test (431 pass, 41 skip)
- PRs: