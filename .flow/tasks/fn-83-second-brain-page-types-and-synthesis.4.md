---
satisfies: [R8, R9]
---

## Description

Cross-cutting documentation sync so no surface is stale at spec completion: agent skill assets (ClawHub-eligible), the hosted website repo `/Users/gordon/work/gno.sh`, remaining user docs, and CHANGELOG finalization. Runs last so docs reflect final shipped behavior from `.1`–`.3`.

**Size:** M
**Files:** `assets/skill/{SKILL.md,cli-reference.md,mcp-reference.md,examples.md}`, `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx`, `/Users/gordon/work/gno.sh/src/lib/product-pages.ts`, `docs/{QUICKSTART.md,WEB-UI.md,USE-CASES.md,GLOSSARY.md}`, `README.md`, `website/_data/features.yml`, `CHANGELOG.md`.

## Approach

- **Skill assets (ClawHub bump warranted — new capability):** enumerate the 4 new preset IDs in `assets/skill/SKILL.md` (capture section ~L212), `cli-reference.md` (~L116, currently only `source-summary`), `mcp-reference.md` (presetId enum), add one realistic example per preset in `examples.md`. (ClawHub publish itself is a manual post-merge step per CLAUDE.md — just make assets ready.)
- **Hosted `gno.sh`:** `src/lib/gno-docs.tsx` (capture ~L849, note-presets ~L1269) — add presetId + list new IDs; `src/lib/product-pages.ts` (capture ~L108, preset FAQ ~L767-788) — update preset FAQ to include note presets + the synthesis/timeline pattern; mention `contentTypes` config where relevant.
- **Remaining user docs:** `docs/QUICKSTART.md` (capture section ~L155 — name presets), `docs/WEB-UI.md` (quick-capture/preset-insert), `docs/USE-CASES.md` (second-brain scenarios use typed presets), `docs/GLOSSARY.md` (add "Note Preset" + "Content Type" terms), `README.md` (second-brain capture mentions typed presets).
- `website/_data/features.yml` — note typed preset scaffolds if the capture feature card warrants it.
- Finalize `CHANGELOG.md [Unreleased]` (presets + typing + config) if not already complete from `.1`–`.3`.
- Run `bun run website:sync-docs` if repo docs changed that the website mirrors.

## Investigation targets

**Required:**

- `assets/skill/cli-reference.md:116`, `assets/skill/SKILL.md:212`, `assets/skill/examples.md` — skill surfaces.
- `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx:849,1269`, `/Users/gordon/work/gno.sh/src/lib/product-pages.ts:108,767-788` — hosted site.
- `docs/GLOSSARY.md`, `docs/QUICKSTART.md:155`, `docs/WEB-UI.md` — user docs.

**Optional:**

- CLAUDE.md "ClawHub Release" section — when/whether to bump skill version.

## Acceptance

- [ ] R9: skill assets (SKILL/cli-reference/mcp-reference/examples) enumerate the 4 new presets + examples; ClawHub-ready.
- [ ] R9: hosted `gno.sh` (gno-docs.tsx + product-pages.ts) updated for new presets + (if shipped) `contentTypes`.
- [ ] R8: `docs/QUICKSTART.md`, `docs/WEB-UI.md`, `docs/USE-CASES.md`, `docs/GLOSSARY.md`, `README.md` reflect typed presets + the synthesis/timeline pattern.
- [ ] CHANGELOG `[Unreleased]` complete; `website/_data/features.yml` current.
- [ ] No GNO doc surface stale (repo `docs/`, `spec/`, skill, website, gno.sh).

## Done summary
Synced the second-brain page-type, synthesis, timeline, and contentTypes behavior across repo docs, skill assets, hosted gno.sh docs/product surfaces, and the changelog. Added the final API/MCP metadata examples requested by review without changing product behavior.
## Evidence
- Commits: 7a14baa, 78d5464, dc43338
- Tests: GNO: bun run lint:check && bun test && bun run docs:verify, gno.sh: bun run typecheck && bun run check && bun test, RepoPrompt impl review: VERDICT=SHIP
- PRs: