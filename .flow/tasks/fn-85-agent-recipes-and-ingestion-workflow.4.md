---
satisfies: [R1, R5, R6, R8, R9]
---

## Description

Run the agent-skill behavior verification, autoresearch evaluation, final package proof, and stale/false surface audit. Update skill text only if evaluation shows a regression or routing weakness.

**Size:** M
**Files:** `assets/skill/SKILL.md`, `assets/skill/recipes/*.md`, `assets/skill/README.md`, `assets/skill/examples.md`, `README.md`, `docs/**/*.md`, `website/**/*`, `/Users/gordon/work/gno.sh/src/**/*`, `~/repos/autoresearch-gno-skill/skill.md` if iteration is required, generated eval logs/evidence as appropriate, Flow task evidence.

## Approach

- Verify installed and previewed recipe assets first, using the behavior from task 1.
- Run final `npm pack --dry-run` or equivalent evidence after all recipe files exist, not only after task 1 placeholders.
- Before autoresearch iteration, seed `~/repos/autoresearch-gno-skill/skill.md` from current `assets/skill/SKILL.md` so copy-back cannot clobber the new recipe router.
- Run the GNO skill autoresearch eval from the project instructions.
- If score is below target or behavior regresses, iterate in `~/repos/autoresearch-gno-skill/skill.md`, copy the winning skill back to `assets/skill/SKILL.md`, verify router links remain, reinstall, and rerun focused checks.
- Run a stale/false surface audit over recipes and changed docs for nonexistent commands, unsupported flags/targets, MCP tools/prompts, runtime commands, native connector claims, cron claims, and background-agent claims.
- Keep Evalite (`bun run eval`) out of this task unless the user explicitly asks; this task uses the separate GNO skill autoresearch eval.

## Investigation targets

**Required**

- `AGENTS.md:183-199` — autoresearch workflow and skill source of truth.
- `assets/skill/SKILL.md` — router under test.
- `assets/skill/recipes/*.md` — recipes under test.
- `docs/integrations/skills.md`, `docs/CLI.md`, `docs/MCP.md`, and hosted `gno.sh` skill/workflow docs — docs surfaces included in stale/false audit.
- `test/cli/skill.test.ts` — install/show behavior tests from task 1.
- `package.json` — package `files` evidence for final recipe assets.

**Optional**

- `spec/evals.md` — only for background; do not run local Evalite unless requested.
- `~/repos/autoresearch-gno-skill/` — eval harness and candidate skill text.

## Key context

Gordon explicitly asked previously to keep Evalite out of standard release workflow unless requested because it kills the machine. Do not substitute Evalite for the autoresearch skill eval here. The first plan review also flagged that existing docs may already include stale skill command/flag/target claims; this final audit is broader than native-connector wording.

## Acceptance

- [ ] `gno skill show --all` and `gno skill show --file <recipe>` demonstrate recipe discoverability.
- [ ] `gno skill install --scope user --force --target all` installs recipe assets; if a target is unavailable or path behavior changed, evidence explains the blocker.
- [ ] Final `npm pack --dry-run` or equivalent evidence proves the completed recipe files ship in the package.
- [ ] Before autoresearch iteration, the experiment skill is seeded from current `assets/skill/SKILL.md` or evidence shows no iteration was needed.
- [ ] `cd ~/repos/autoresearch-gno-skill && uv run eval.py > run.log 2>&1` is run and the score/result is recorded.
- [ ] If autoresearch regresses, the winning `skill.md` is copied back to `~/work/gno/assets/skill/SKILL.md`, router table/recipe links are verified, reinstalled, and retested.
- [ ] Stale/false surface audit confirms no unqualified native Gmail, Calendar, Slack, webhook, cron, API-fetch, autonomous background-agent, nonexistent GNO command, unsupported flag/target, or nonexistent MCP tool/prompt claims in recipes or updated docs.
- [ ] Audit confirms write-flavored recipes mention provenance and post-write sync/index/embed/search verification.
- [ ] Final task evidence includes commands run, eval result, any blockers, and whether hosted `gno.sh` docs were built/deployed or left with an explicit blocker.

## Done summary

Reran the GNO skill autoresearch eval from a current-router seed and completed the stale/false surface audit. Eval scored 100% (48/48), so no router iteration was needed. Verified local source install/preview includes nested recipe files, npm dry-run includes all recipes, full tests pass, lint passes, and docs verification passes.

## Evidence

- Commits: a429dbc, 70e3e8b, 3a826c7, 4fbf69c, 753cbdd
- Tests: cd ~/repos/autoresearch-gno-skill && uv run eval.py > run.log 2>&1 (score 100.0, 48/48), bun run lint:check, bun test (2013 pass, 1 skip, 0 fail), bun run docs:verify, bun src/index.ts skill install --target codex --scope user --force, bun src/index.ts skill show --file recipes/brain-first-lookup.md, npm pack --dry-run (all seven assets/skill/recipes/\*.md listed), rg stale-claim audit over README.md docs website assets/skill spec
- PRs:
