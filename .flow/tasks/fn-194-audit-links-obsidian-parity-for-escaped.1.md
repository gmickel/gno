---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-194-audit-links-obsidian-parity-for-escaped.1 Implement Audit links: Obsidian parity for escaped table aliases, attachments and targets outside the index

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
`gno audit links` now matches Obsidian on the synthetic vault. Wiki links with a table-escaped alias (`[[Note\|Alias]]`) and Markdown link text that contains brackets parse correctly. Unresolved workspace wiki links whose target exists as a file that is not indexed become passing `links.outside-index` info findings. Only genuinely missing targets stay in `links.local-targets`.

- R1: `splitWikiLinkContent` in `src/core/links.ts` is used by stored links (graph, backlinks, links, impact, neighbours, audit), the reader preview and the rename inventory. `INGEST_VERSION` 8 re-parses existing indexes once. Tests: `test/core/links.test.ts` (Obsidian parity), `test/ingestion/sync-links.test.ts` (re-parse on upgrade), `MarkdownPreview.dom.test.tsx`, `file-refactor-planner.test.ts`.
- R2: `src/core/audit-outside-index.ts` does an existence-only check. It opens no files, creates no edge and never indexes the excluded folder. An incomplete listing leaves the link unresolved and adds one diagnostic to the rule message. Info findings keep a rule passing (`src/core/audit.ts`). Tests: `test/audit/link-workspace-audit.test.ts`, `test/audit/report.test.ts`.
- R3: the resolver's match classes are shared through `workspaceMatchClass`, with `createWorkspaceFileMatcher` built on them. Non-Markdown targets need their extension. Each workspace is listed once per run, capped at 200,000 files, with hidden folders skipped. Test: `test/store/link-workspace-resolution.test.ts`.
- R4: Markdown link text may contain one level of balanced brackets, and a destination that contains a bracket is skipped.
- R5: covered by the fixture test and by live QA. Before: 8 unresolved. After: 1 unresolved (`[[Nowhere]]`) and 4 outside-index. After an upgrade, the first `gno update` brings unresolved from 4 to 1.
- R6: updated `docs/CONFIGURATION.md` ("Links to files GNO does not index"), `docs/CLI.md`, `docs/ARCHITECTURE.md`, `docs/MCP.md`, `docs/GLOSSARY.md`, `spec/cli.md`, `spec/mcp.md`, the CHANGELOG, the skill and gno.sh (branch `fn-194-audit-parity`).

Follow-ups, not built:
- Markdown links (`[x](file.pdf)`) to attachments are still resolved per collection only.
- Files in a nested vault count as existing for links from the outer vault.

stage: impl-review - skipped(config: user instruction, no model review)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: bded4e0d9d16e98af707ea520b20d5a1a668a956, ff866792260d5c279c6312d21992513b06ae1864
- Tests: mise exec bun@1.4.2 -- bun test (5927 pass, 3 skip, 0 fail), mise exec bun@1.4.2 -- bun run lint:check, mise exec bun@1.4.2 -- bun run docs:verify, live QA: gno audit links --json --max-findings all before/after on synthetic vault (.flow/tmp/qa-fn-194-audit-links-obsidian-parity-for-escaped/), gno.sh (fn-194-audit-parity cece7dc): bun run check && bun run typecheck && bun run test
- PRs: