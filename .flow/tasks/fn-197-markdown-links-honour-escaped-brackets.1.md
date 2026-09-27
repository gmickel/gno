---
satisfies: [R1, R2, R3]
---
# fn-197-markdown-links-honour-escaped-brackets.1 Implement Markdown links: honour escaped brackets and reject destinations with spaces

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Markdown link extraction now reads links the way CommonMark and Obsidian do. An escaped `[` opens no link. A destination with an unescaped space is plain text unless it is wrapped in `<...>`. `[x](<my note.md>)` now resolves; on v2.8.2 it did not, because the angle brackets stayed in the target.

Approach: I extended the existing scanner instead of switching to the mdast parser. `parseLinks` now matches only the `[text](` opener and reads the destination with the repo's existing CommonMark reader, `parseParenthesizedDestination`, which the file-refactor inventory already used. I rejected the parser switch for three reasons:
- mdast normalises `url` (it percent-encodes non-ASCII), so raw-source slicing would still be needed.
- It would parse every note that contains `](`, while fn-195 bounded parser cost to notes that may contain code.
- Two scanners would keep two destination rules.

Wiki-link parsing is unchanged.

- R1: `isBackslashEscaped` in `src/core/link-destination-parse.ts`. An odd run of backslashes before `[` skips the candidate, and a link may still start at a later `[`. `\]` in the link text is literal. The refactor inventory (`inventoryInlineMarkdown`) applies the same rule, so a rename never rewrites `\[text](note.md)`. Tests: `test/core/links.test.ts` ("CommonMark link rules", 12 cases) and `test/core/file-refactor-planner.test.ts` ("never rewrites an escaped-bracket Markdown clause").
- R2: `readInlineDestination` in `src/core/links.ts`. The destination ends at unescaped whitespace, an optional title follows, then `)`; anything else is not a link. Angle brackets are stripped and CommonMark escapes are unescaped, so `a\(b\).md` becomes `a(b).md`. `%20` behaves as before. Link titles no longer end up in `targetRef`. The fn-60.6 pin that asserted the old `note.md "Title"` target now expects `note.md`; this is a declared R2 change.
- R3: `test/audit/link-workspace-audit.test.ts` ("Markdown link text that CommonMark reads as plain text"). The fixture has an escaped clause, an unescaped spaced clause, `<my note.md>` and `my%20note.md`. It checks for zero audit findings and two backlinks to `my note.md`. All new tests fail on base ffa580f9 (11 red) and pass on the branch.
- Regression comparison, old against new `parseLinks`, over 2,507 Markdown files and 4,919 links: this repo's Markdown (docs, spec, fixtures, .flow), ~/repos, gno.sh, mickel.tech and agent-instructions. Exactly one extraction changed: `[Elixir](<https://en.wikipedia.org/wiki/Elixir_(programming_language)>)`. The old regex cut it at the first `)` into a garbage relative target; it is now an external URL and skipped. Parse time: 419 ms before, 529 ms after on ~/repos.
- INGEST_VERSION 10. Live QA (`.flow/tmp/qa-fn-197-markdown-links-honour-escaped-brackets/summary.json`) on an index built and embedded by origin/main v2.8.2: 3 unresolved findings before (both clauses and `<my note.md>`). The first branch `gno update` re-processed 3 docs, and afterwards `embeddingBacklog` was 0 of 3 chunks, with 0 findings and 4 of 4 links resolved. A fresh index gives the same links. The `gno links` output is saved there as well.
- Docs: spec/cli.md link rules, docs/ARCHITECTURE.md, and CHANGELOG [Unreleased] Fixed. gno.sh worktree /home/gordon/work/gno-sh-fn197, branch fn-197-markdown-link-rules, commit e7d6959: one paragraph on the configuration docs page. Its checks, typecheck, 431 tests and build all pass, and it renders at 375 px with no overflow (screenshots are in the QA folder).

Not changed, per coordination with fn-196: audit classification and the change journal. `change-diff.ts` consumes `parseLinks`, so journal link summaries pick up the same parsing. The shipped skill (`assets/skill`) is unchanged; it does not describe Markdown link syntax.

stage: impl-review - skipped(config: repo rules skip all review stages; no model review requested)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 9991e97749fb8be8ecdd8541079d3194fe8dc1a2, e0d2a31974bc1eacab3dea2b712ea36fe11c6a15
- Tests: baseline: none (spec defines no Quick commands); red-first: 11 new/changed tests fail on base ffa580f9 in a detached worktree, mise exec bun@1.4.2 -- bun test (suite_rc=0: 5973 pass, 3 skip, 0 fail), mise exec bun@1.4.2 -- bun run lint:check (0 errors, 45 pre-existing warnings), mise exec bun@1.4.2 -- bun run docs:verify (15 passed, 2 skipped), corpus comparison old vs new parseLinks: 2,507 files, 4,919 links, 1 changed (correct removal); .flow/tmp/qa-fn-197-markdown-links-honour-escaped-brackets/corpus-compare-*.txt, live QA: before v2.8.2 3 unresolved; after upgrade 0 findings, 4/4 resolved, 3 docs re-processed, embeddingBacklog 0 of 3 chunks; fresh identical; .flow/tmp/qa-fn-197-markdown-links-honour-escaped-brackets/summary.json, gno.sh e7d6959: bun run check && bun run typecheck && bun run test (431 pass, 41 skip) && bun run build; rendered at desktop and 375px
- PRs: