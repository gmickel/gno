---
satisfies: [R1, R5]
---
# fn-133-site-and-docs-memory-positioning-agents.1 Memory positioning: feature page + FAQ truth updates

## Description
Memory positioning: feature page + FAQ truth updates. **Size:** M. **Files/Touches (exclusive):** gno.sh src/lib/product-pages.ts (ALL edits to this file live in this task — task 3 must not touch it), src/lib/site-content.ts IN FULL (FAQ entries AND every other claim in that file needing the profile/memory story, incl. the '25 read-only tools' surfaces-card line ~191 — task 3 does not touch this file), src/lib/gno-docs.tsx memory docs page, src/lib/prerender-routes.ts + sitemap entries for any NEW slugs.
Site memory page(s) under "one auditable memory store for every agent you authorize" — mechanisms only (four surfaces, supersession, fencing incl. paraphrase limit, scopes, edit/capture/remember taxonomy); FAQ agent-memory answer updated from retrieve-on-demand-only; homepage truth-updates only. Every claim maps to shipped behavior.

**Touches:** gno.sh: src/lib/product-pages.ts (exclusive), src/lib/site-content.ts (exclusive), src/lib/gno-docs.tsx memory page region, src/lib/prerender-routes.ts + sitemap for new slugs

## Acceptance
- [ ] Memory page(s) live locally with mechanism-level copy; every claim traced to shipped code
- [ ] New slugs present in prerender-routes + sitemap (build output verified)
- [ ] FAQ updated; homepage untouched beyond truth updates
- [ ] No other task's files touched

## Done summary
Site memory positioning shipped in the gno.sh worktree (commit c1ed6422 on fn-133-site-and-docs-memory-positioning-agents, base bd2b649e): a new /features/agent-memory page under "one auditable memory store for every agent you authorize" with mechanism-level copy, a new /docs/memory Guides page derived from docs/MEMORY.md at gno v1.45.0, MCP tool-count truth updates (34 read-only, 19 write, 53 total; opt-in core profile 7 read + 2 write), and the landing and product FAQ agent-memory answers rewritten from retrieve-on-demand-only to remember/recall. Both new slugs are in prerender-routes.ts; the sitemap derives from it and the build output carries both.

Files (all within this task's Touches): src/lib/product-pages.ts, src/lib/site-content.ts, src/lib/gno-docs.tsx (new "memory" page, nav entry, one linking sentence in the use-cases "Memory for Claude Code" section), src/lib/prerender-routes.ts, src/lib/product-pages.test.ts (one new lock), src/lib/public-truth-content.test.ts (tool-count lock moved from 25/15/40 to 34/19/53 because this task changed those claims in its own files; the positive lock is satisfied by product-pages.ts and site-content.ts).

Every claim traced: docs/MEMORY.md and src/core/memory-types.ts (4096 bytes, 1-8 scopes, 64 chars, pool 16, cosine 0.83, Jaccard 0.5, 8 facts / 512 tokens, MEMORY_* codes, fence + paraphrase limit, exclusions), src/mcp/tools/index.ts + tool-profile.ts (counts verified by registering the tool set at HEAD), src/cli/commands/memory.ts (--scope, --add, --supersede, --predecessor-hash, --receipt, --max-facts, --max-tokens), src/cli/commands/agents/block.ts (v3 ladder rung + writing contract), assets/skill/recipes/memory-*.md (three recipes), integrations/hermes-gno-memory and openclaw-gno-memory READMEs (Hermes v0.20.5, OpenClaw 2026.8.1, OpenClaw plugin retrieves only).

Homepage: only the Agents surfaces card and two FAQ answers changed (truth updates); no new highlight card, no restructure.

Left for task 3 (not this task's files): src/lib/gno-docs.tsx MCP reference page still says 32 read-only / 18 write / 50 total, the cursor docs page says 25 read-only, and src/lib/integration-pages.ts carries 25/15; docs/MCP.md in the gno repo itself carries a stale 33/51 overview sentence beside the correct 34/19/53 security section. After task 3 sweeps those, add 25/15/40 to the public-truth negative-match list.

Deviation: `bun run dev` returns 500 in this worktree because Vite follows the node_modules symlink to ~/work/gno.sh and refuses to load the react-start/nitro dev entries from outside the root; the pages were driven against the production build served on port 3344 instead (same route code, prerendered + SSR). Not a site-source issue.

stage: impl-review - skipped(config: REVIEW_MODE=none)
## Evidence
- Commits: c1ed6422d1c0a0c74629dc270bc72908b23fe62d
- Tests: baseline: none (spec defines no Quick commands); site gates green pre-edit: bun run check, bun run typecheck, bun run test (195 passed, 5 skipped), site-fn-133: bun run check (rc=0), site-fn-133: bun run typecheck (rc=0), site-fn-133: bun run test (rc=0; 196 passed, 5 skipped; +1 lock: product-pages.test.ts 'states the memory contract with its four surfaces and fence limit'), site-fn-133: bun run build (rc=0; prerender output lists /features/agent-memory and /docs/memory; .output/public/sitemap.xml carries both <loc> entries), driven on http://localhost:3344 (production build served with PORT=3344 node .output/server/index.mjs because `bun run dev` 500s in this worktree: Vite resolves the symlinked node_modules to ~/work/gno.sh and refuses to load @tanstack/react-start and nitro dev entries from outside the root): / 200, /faq 200, /features 200, /features/agent-memory 200, /features/mcp-integration 200, /features/agent-integration 200, /docs 200, /docs/memory 200, /docs/use-cases 200, /sitemap.xml 200; rendered text probes: headline 'One auditable memory store for every agent you authorize', MEMORY_SCOPES_REQUIRED, paraphrase fence limit, 8 facts / 512 tokens, 'What the fence cannot do', Hermes v0.20.5, OpenClaw 2026.8.1, homepage Agents card '34 read-only tools by default, or a 7-tool core profile', FAQ 'hash-checked supersede', /features index card 'Agent Memory', sitemap locs for both new slugs, truth check: bun scratch script registering src/mcp/tools at gno HEAD (v1.45.0) -> full profile 34 read / 53 with writes (19 write), core profile 7 read / 9 with writes
- PRs: