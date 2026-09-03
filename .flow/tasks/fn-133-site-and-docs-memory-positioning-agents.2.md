---
satisfies: [R3, R4, R5]
---
# fn-133-site-and-docs-memory-positioning-agents.2 Agents-install reference + public protocol page

## Description
Agents-install reference + public protocol page. **Size:** M. **Files/Touches (exclusive):** gno.sh src/lib/gno-docs.tsx new agents-install + protocol pages, prerender-routes.ts + sitemap for those slugs.
Reference for gno agents install (verified harness matrix with evidence, marker/versioning semantics, what the block teaches) positioned as a user-configurable knowledge protocol; the retrieval ladder + writing contract as a public docs page (generalized, no vault-specific machinery).

**Touches:** gno.sh: src/lib/gno-docs.tsx agents-install + protocol page regions, src/lib/prerender-routes.ts + sitemap for those slugs

## Acceptance
- [ ] Both pages live locally; harness matrix carries evidence lines; ladder matches the shipped block
- [ ] Slugs in prerender-routes + sitemap
- [ ] No vault-specific conventions leaked into the public protocol page

## Done summary
Two hosted-site docs pages shipped in the gno.sh worktree (commit 20687f7 on fn-133-site-and-docs-memory-positioning-agents, base c1ed6422): /docs/agents-install (Reference, "Agent instructions") is the gno agents reference — the seven-harness matrix with the evidence behind it, marker and version-stamp semantics, verify statuses and exit codes, installer guarantees, --extra-dir, the v3 block content, the v1→v2→v3 history, and multi-machine practice — positioned as a user-configurable knowledge protocol; /docs/protocol (Guides, "Knowledge protocol") is the generalized retrieval ladder (seven rungs with what each returns and where it stops) plus the edit/capture/remember writing contract with the receipt fence and a "where the protocol stops" section. Both slugs are in docsRouteSlugs, so prerender and both sitemap projections carry them; nav entries added under Reference and Guides.

Files (all within Touches): src/lib/gno-docs.tsx (two new page regions + two nav entries; no other region edited, tool-count lines untouched), src/lib/prerender-routes.ts (two slugs). No edits to product-pages.ts, site-content.ts, gno-comparisons.tsx, integration-pages.ts. No gno-repo source change.

Evidence honesty on the matrix: the page states that the file locations and fresh-session behavior come from the hand-managed three-host/seven-harness reference deployment, that the shipped installer's live verification ran in an isolated home (GNO_AGENTS_HOME_OVERRIDE) and not on production instruction files, and that the Hermes/OpenClaw live verifications belong to the memory adapters (v0.20.5 real host; 2026.8.1 sandbox). The protocol page names commands only — no vault, Spaces/System, or personal collection names (probed on the rendered page).

Gates in the site worktree: check, typecheck, test (196 pass / 5 skip), build green on the committed tree; driven on the production build at http://localhost:3344 (bun run dev still 500s in this worktree, same cause fn-133.1 recorded). Not pushed, not deployed — the conductor owns both.

Follow-ups (not built): the existing skills-page "Instruction block" section and the CLI page's gno agents heading could link to /docs/agents-install (outside this task's new-region Touches); docs/AGENT-INSTRUCTIONS.md in the gno repo still shows the stale illustrative stamp comment fn-135.2 flagged.

Staging note: the gno-repo receipt commit stages the task file by explicit path because the checkout carries pre-existing untracked .flow/artifacts/* directories that earlier workers were told not to touch.

stage: impl-review - skipped(config: REVIEW_MODE=none)
## Evidence
- Commits: 20687f70b102104aee45ba304ba1fd24f90eb0e1
- Tests: baseline: green via handoff (verified at c1ed6422 by fn-133.1: check / typecheck / test 196 pass / build in the site worktree); the spec defines no Quick commands for the gno repo and this task changes no gno-repo file (flowctl gate classify --base b89eca97 -> TIER_B docs-only), site-fn-133: bun run check (rc=0), site-fn-133: bun run typecheck (rc=0), site-fn-133: bun run test (rc=0; 196 passed, 5 skipped; no new locks - both pages are prose reference and the existing docsRouteSlugs/docsBySlug consumers cover the slugs), site-fn-133: bun run build (rc=0; prerender output lists /docs/agents-install and /docs/protocol; .output/public/sitemap.xml carries both <loc> entries; the runtime /sitemap.xml route reads the same prerenderPageEntries()), driven on http://localhost:3344 (production build, PORT=3344 node .output/server/index.mjs; bun run dev 500s in this worktree per fn-133.1): / 200, /docs 200, /docs/agents-install 200, /docs/protocol 200, /docs/memory 200, /docs/skills 200, /sitemap.xml 200; rendered-text probes: agents-install carries 'Harness matrix: who reads which file', 'covered via claude', '1,491 characters', 'Hermes v0.20.5', 'OpenClaw 2026.8.1', 'gno:agents:begin', the isolated-home evidence line ('production instruction files'), manualBlock; protocol carries 'The retrieval ladder', rung-1..rung-7 anchors, '8 facts under 512 estimated tokens', 'exact span plus declared origin', 'Where the protocol stops'; the docs index sidebar links both new slugs; sitemap locs for both; no 'vault' / 'Spaces/System' text on either page (the only 'Gordon' on the page is the site-wide imprint chrome, present on /docs too), truth check: ladder and writing contract transcribed from src/cli/commands/agents/block.ts at gno v1.45.0 (BLOCK_VERSION 3, renderBlockBody().length = 1491, budget < 1500 in test/cli/agents.test.ts); harness rows from src/cli/commands/agents/harnesses.ts + docs/AGENT-INSTRUCTIONS.md; verify statuses, plan actions, and exit codes from src/cli/commands/agents/commands.ts + engine.ts; recall budget, receipt fence, remember propose/add/supersede table, and the lexical-mode caveat from docs/MEMORY.md; live-verification facts from the fn-129.1, fn-135.1 (Hermes v0.20.5 on a real host), and fn-135.3 (OpenClaw 2026.8.1 isolated sandbox) done summaries, copy-rule sweep on the new regions: promotional-vocabulary and negative-parallelism grep over the two page fragments; one hit ('declared rather than hidden') rewritten before commit; the remaining 'no longer matches its hash' is a precise technical distinction
- PRs: