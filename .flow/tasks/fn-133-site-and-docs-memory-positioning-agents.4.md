---
satisfies: [R1, R2, R3, R4, R5]
---
# fn-133-site-and-docs-memory-positioning-agents.4 Copy-rule pass, gates, deploy, prod QA

## Description
Copy-rule pass, gates, deploy, prod QA. **Size:** S. **Files/Touches:** scripts/smoke-web.ts assertions if headlines changed; deploy execution only otherwise.
Anti-slop copy review over all changed pages (findings addressed or explicitly accepted, recorded in the PR); bun run check/typecheck/build + content tests; drive changed pages on :3344; deploy from heimdall; verify the same pages live on https://gno.sh with captured evidence per the site QA gate.

**Touches:** gno.sh: scripts/smoke-web.ts (assertions), deploy execution

## Acceptance
- [ ] Copy-review findings recorded with dispositions
- [ ] Site gates green; changed pages driven locally AND on prod with evidence (URLs + assertions)
- [ ] Deploy verified: remote HEAD matches origin/main, service active

## Done summary
Copy-rule pass over every page tasks .1-.3 changed in the gno.sh worktree (`git diff main...d0661d6b`: /features/agent-memory, /docs/memory, /docs/agents-install, /docs/protocol, /comparisons/qmd, /comparisons/gbrain, /docs/mcp, /docs/cursor, /docs/claude-desktop, /docs/use-cases, /integrations/claude-desktop, /integrations/amp, the homepage surfaces card and FAQ lines, the /features/mcp-integration and /features/agent-integration bullets). Two site commits on `fn-133-site-and-docs-memory-positioning-agents` in /home/gordon/work/gno-ws/site-fn-133 (base d0661d6b): a523da4 (copy fix, the two truth leftovers, two test locks) and 0b97144 (smoke-web assertions). No gno-repo source change; the gno checkout range 2ebeb50e..HEAD is empty. Not pushed, not deployed, `flowctl done` not run; the conductor owns deploy, production QA, and completion.

### Copy-review findings (PR body table)

Every added line was read against the copy rules (positive frames, mechanism-first headlines, no promotional vocabulary, negative parallelism only for precise distinctions and honest limits, honest bounds, every numeric or behavioral claim traceable to gno v1.45.0). A vocabulary grep over the added lines (powerful, seamless, effortless, blazing, supercharge, unlock, game-changing, robust, revolution, cutting-edge, magic, instantly, simply, just, easy, delight, elegant, leverage, empower, frictionless, truly, genuinely) hit only "genuinely"; a negative-construction grep (`not X, but/just Y`, `never`, `instead of`, `rather than`) returned 38 lines, each read individually.

| # | Page / file | Finding | Rule | Disposition |
|---|---|---|---|---|
| 1 | /integrations hub, `src/routes/integrations.index.tsx:67` | "the fifteen mutating tools require an explicit flag" was stale (ground truth 19 write / 34 read-only / 53 total at v1.45.0, `src/mcp/tools/tool-profile.ts` + `index.ts`) | traceable claim | **fixed** (a523da4): "the nineteen write tools, `gno_remember` among them, require an explicit flag"; route file joins the `STALE_TOOL_COUNTS` sweep in `public-truth-content.test.ts` (regex shown red against `git show HEAD:src/routes/integrations.index.tsx` before the edit, green after) |
| 2 | `src/lib/prerender-routes.ts` `comparisonRouteSlugs` | `gbrain` missing: /comparisons/gbrain rendered via SSR only, absent from prerender output and both sitemap projections | truth / reachability | **fixed** (a523da4): slug added; new lock "prerenders and sitemaps every comparison page" (red first: `expected [...] to include 'gbrain'`), build output now carries `.output/public/comparisons/gbrain/index.html` and `/comparisons/gbrain` in `sitemap.xml` |
| 3 | /docs/agents-install, evidence list | "a future chain is a new row, not a code change" | negative parallelism, not a limit | **fixed** (a523da4): "a future chain is one more row in the matrix" |
| 4 | `scripts/smoke-web.ts` "/" assertions | "Search everything you know." / "Point it at your Markdown" / "Local Knowledge Workspace" no longer render (hero changed on main in c773111, before this branch); `bun run smoke:web` is also unrunnable in this worktree (vite dev never answers, fn-133.1 deviation) | gate truth | **fixed** (0b97144): "/" now asserts the rendered hero + surfaces card; assertions added for the five new routes; every string verified against the production build on :3344 since the dev-server path cannot run here |
| 5 | /features/agent-memory, /docs/memory, /docs/protocol, /docs/agents-install: "genuinely new document/note" (4 uses) | intensifier | **accepted**: quotes the shipped v3 block body verbatim (`renderBlockBody()` in `src/cli/commands/agents/block.ts`: "creates genuinely new notes") and carries the edit-vs-capture distinction |
| 6 | /docs/agents-install: "a knowledge protocol you configure, not a note-taking convention" | negative parallelism | **accepted**: the spec's own positioning sentence (fn-129/fn-133 "a user-configurable knowledge protocol, not a vault convention"), a precise distinction |
| 7 | /docs/memory: "Remember is not a second capture", "Scopes are a visibility partition, not an access-control boundary", "a guard against the accidental replay loop, not a proof of provenance", "Treat receipts as part of the agent's contract, not as a security boundary", "These are exclusions, not gaps" | negative parallelism | **accepted**: each states an honest limit or a precise distinction, the two cases the rules allow; the fence-limits paragraph and the exclusions list are the page's honesty section |
| 8 | /features/agent-memory bullets: "Supersession instead of edits", "Nothing is deleted by the contract", "no automatic capture, no model in the write path, ..." | negative frames | **accepted**: honest bounds mirrored from `docs/MEMORY.md` "What memory does not do"; the headline stays positive ("One auditable memory store for every agent you authorize") |
| 9 | Homepage FAQ / site-content: "A fact is replaced by a hash-checked supersede, never edited in place", "Nothing is captured automatically and no model sits in the write path" | negative frames | **accepted**: honest bounds, both traceable to `src/core/memory-remember.ts` (no model in the path) and the supersede contract |
| 10 | /comparisons/qmd: "Qmd returns ranked documents and qmd:// URIs rather than generated answers"; "Qmd stays a CLI and MCP server by design, a complete tool when search is the whole job" | competitor framing | **accepted**: precise distinction verified by task .3 against qmd 2.8.3 (README commit dbfd0b4); the competitor is framed positively |
| 11 | /docs/protocol "Where the protocol stops": "The ladder is a default order, not a gate", "Verification is per claim, not per fact" | negative parallelism | **accepted**: honest limits in the bounds section |
| 12 | `src/lib/integration-pages.ts:44` header comment "eleven different product names" while ten pages exist | comment only, not rendered | **accepted**, out of scope (not a line tasks .1-.3 changed; no user-facing surface); follow-up |

### Claim traceability (checked against gno HEAD 2ebeb50e, `git diff --stat v1.45.0 HEAD -- src` empty)

- Memory constants: `MEMORY_CANDIDATE_POOL = 16`, `MEMORY_SEMANTIC_LIKELY_THRESHOLD = 0.83`, `MEMORY_LEXICAL_LIKELY_THRESHOLD = 0.5`, `MEMORY_RECALL_MAX_FACTS = 8`, `MEMORY_RECALL_MAX_TOKENS = 512` (`src/core/memory-types.ts`); `MEMORY_MAX_SCOPES = 8`, `MEMORY_MAX_SCOPE_CHARS = 64`, `MEMORY_MAX_FACT_BYTES = 4096`, scope pattern `^[\p{L}\p{N}][\p{L}\p{N}._:/@-]*$` (`src/core/memory-record.ts`).
- Error codes named on the pages (`MEMORY_SCOPES_REQUIRED`, `MEMORY_TEXT_TOO_LARGE`, `MEMORY_COLLECTION_UNMANAGED`, `MEMORY_PREDECESSOR_HASH_MISMATCH`, `MEMORY_SUPERSEDE_CONFLICT`, `MEMORY_FENCED_REPLAY`, `MEMORY_FENCED_DERIVED`, `MEMORY_WRITE_LEASE_BUSY`, `MEMORY_SUPERSEDE_PROJECTION_FAILED`) all exist in `src/core/memory-types.ts`; HTTP 409 / CLI exit 4 for the conflict per `src/serve/routes/api.ts:3716`, `src/cli/commands/memory.ts:248`, `docs/MEMORY.md:303`.
- CLI flags `--add`, `--supersede`, `--predecessor-hash`, `--receipt`, `--derived-from`, `--caller`, `--session`, `--max-facts`, `--max-tokens` and the `$GNO_MEMORY_CALLER` / `cli:<user>` / `ppid:<pid>` defaults: `src/cli/program.ts:1930-2010`.
- MCP `gno_recall` runs the lexical leg only: `createMcpMemoryService` passes no embedding port (`src/mcp/tools/memory-shared.ts:71`).
- Fact path `facts/<YYYY-MM-DD>/mem-<16 hex>.md`, `PUT /api/docs/:id`, the three memory recipes (`assets/skill/recipes/memory-*.md`), Hermes v0.20.5 and OpenClaw 2026.8.1 (`integrations/*/README.md`, `docs/MEMORY.md`).
- Agents block: `BLOCK_VERSION = 3`, `renderBlockBody().length === 1491`, test budget `< 1500` (`test/cli/agents.test.ts:166`), seven rungs with recall at rung 2, backup `<file>.gno-agents.bak.<ts>`, `covered via <target>` and `not-detected` statuses, exit 1 validation / 2 runtime (`src/cli/commands/agents/*`); "three hosts, seven harnesses" from `.flow/specs/fn-129-...md` and `docs/AGENT-INSTRUCTIONS.md:31`.
- MCP install targets: ten (`MCP_TARGETS` in `src/cli/commands/mcp/paths.ts`); tool counts 34/19/53 and core 7+2 re-derived by task .3.

### Gates (site worktree, committed tree at 0b97144; sources unchanged since the a523da4 build)

- `bun run check` rc=0; `bun run typecheck` rc=0; `bun run test` rc=0 (198 passed, 5 skipped; +2 tests); `bun run build` rc=0.
- `bun run smoke:web` rc=1 INCONCLUSIVE: "Timed out waiting for dev server" (the fn-133.1 vite-dev deviation in this worktree, same as task .3 reported); not a page failure. Its assertion strings were evaluated against the production build instead: 0 missing.
- Driven on http://localhost:3344 (`PORT=3344 node .output/server/index.mjs`, production build): 19 routes, 19 pass, 0 stale-count / promotional-vocabulary hits; per-URL probes in the evidence file.

### Follow-ups (not built)

- `src/lib/integration-pages.ts:44` comment "eleven different product names" (ten pages).
- `bun run smoke:web` depends on `vite dev`, which does not come up in this worktree; a base-URL mode would let it run against a production build. Left as is (new capability, outside the task).

stage: impl-review - skipped(config: REVIEW_MODE=none; parallel-wave handover, conductor owns review)

### Conductor completion (deploy + production QA)

- smoke:web: ran in the site worktree with real node_modules (vite dev up): the homepage and feature/docs assertions before /studio pass; /studio returns 500 in this environment because it needs a session and Postgres (no .env, no docker here), so the remaining assertions were replayed against the dev server with the script's tag-stripped matching: 14/14 pass.
- gno.sh PR #37 (`fn-133-site-and-docs-memory-positioning-agents`) squash-merged as 5144fd4d with head pinned; branch deleted.
- Deployed from heimdall with `DEPLOY_HOST=root@178.104.180.89 ./scripts/deploy-prod.sh`; verified `curl -fsSI https://gno.sh` 200, `systemctl is-active gno-sh` active, remote HEAD 5144fd4 == origin/main.
- Production drive: the 19 routes from the local evidence re-probed on https://gno.sh with the same probes plus a stale-count scan: 19/19 pass (one probe miss was normalization only; phrase present in raw HTML); sitemap carries /features/agent-memory, /docs/memory, /docs/agents-install, /docs/protocol, /comparisons/gbrain, /comparisons/qmd. Evidence: .flow/tmp/qa-fn-133-site-and-docs-memory-positioning-agents/ (S1 prod drive, S2 smoke, S3 deploy, prod-driven.json).
## Evidence
- Commits:
- Tests: baseline: green via handoff (verified at d0661d6b by fn-133.3: check / typecheck / test 197 pass / build in the site worktree); no gno-repo Quick commands; gno-repo source untouched by this task, site-fn-133: bun run check (rc=0 on the committed tree), site-fn-133: bun run typecheck (rc=0), site-fn-133: bun run test (rc=0; 198 passed, 5 skipped; +1 lock: prerenders and sitemaps every comparison page, red first on gbrain; +1 source in the STALE_TOOL_COUNTS sweep: src/routes/integrations.index.tsx, regex red on git show HEAD before the edit), site-fn-133: bun run build (rc=0; .output/public/comparisons/gbrain/index.html present; sitemap.xml carries /comparisons/gbrain, /features/agent-memory, /docs/memory, /docs/agents-install, /docs/protocol), site-fn-133: bun run smoke:web (rc=1 INCONCLUSIVE: Timed out waiting for dev server; vite dev does not come up in this worktree, fn-133.1 deviation; every assertion string in scripts/smoke-web.ts evaluated against the production build on :3344 instead: 0 missing), driven on http://localhost:3344 (production build, PORT=3344 node .output/server/index.mjs, sources at a523da4): 19 routes / 19 pass / 0 stale-count or promotional-vocabulary hits; see driven[], claim traceability: memory constants, error codes, CLI flags, MCP lexical-only recall, block v3 body length 1491 < 1500, exit codes, adapter versions, ten MCP targets checked against gno HEAD 2ebeb50e (src identical to v1.45.0), gno.sh site worktree: bun run check / typecheck / test (198 pass, 5 skip) / build rc=0 at 0b97144, bun run smoke:web (real node_modules): pre-/studio assertions pass; /studio 500 = env (session + Postgres absent); remaining 14 assertions replayed against vite dev with tag-stripped matching: 14/14 pass, production drive https://gno.sh at remote HEAD 5144fd4: 19/19 routes pass, sitemap has the 6 new/updated slugs, deploy: gno.sh#37 squash 5144fd4d; heimdall scripts/deploy-prod.sh; curl 200; systemctl active; remote HEAD == origin/main
- PRs: https://github.com/gmickel/gno.sh/pull/37