---
satisfies: [R3]
---
# fn-119-gno-peek-command-desktop-integration.4 Point skill and CLI docs at peek

## Description
Finish R3 surface sync: agents and humans are told to use peek (not `status`+`ls`+`changes`) for cheap snapshot/serve/recent questions, and the frozen deep-link + search `absPath` rules are findable from the skill. Split last so copy matches the landed CLI/MCP/docs contracts.

**Size:** S
**Files:** assets/skill/SKILL.md; docs/CLI.md; docs/MCP.md
**Touches:** assets/skill/SKILL.md; docs/CLI.md; docs/MCP.md; assets/skill/

### Approach
- `assets/skill/SKILL.md`: add `peek` to Command Overview Admin (~93). Route "index health / counts / backlog / is serve up / recent files" to `gno peek --json` / `gno_peek` **before** `gno status` / `gno_status` (today ~352, ~396 send those questions to status). Keep status for activation/health/onboarding. Mention open actions: web `{serveUrl}/doc?uri=…` from peek `serve.url` + `uri`; files via peek `recent[].absPath` or search `source.absPath` (no `gno get` for path-only open).
- `docs/CLI.md`: add `### gno peek` next to `### gno status` (~1515) with `--json` example, uninitialized-success, and a pointer to the frozen deep-link. Do not restate the full status activation essay.
- Confirm `docs/MCP.md` peek section from task 3 still matches the skill wording (one snapshot, three surfaces).
- No new flags, no plugin code, no write surface.

### Investigation targets
**Required** (read before coding):
- `assets/skill/SKILL.md`
- `docs/CLI.md`
- `docs/MCP.md`
- `.flow/specs/fn-119-gno-peek-command-desktop-integration.md`
**Optional**:
- `spec/cli.md`
- `spec/mcp.md`
- `docs/WEB-UI.md`

### Key context
Skill install ships `assets/skill/SKILL.md`; do not only edit a local copy. Hosted `~/work/gno.sh` is outside this spec's R3 list — leave it unless the host expands scope. Autoresearch skill eval is optional and not a gate for this task.

## Acceptance
- [ ] Skill + `docs/CLI.md` tell agents/humans to use peek for snapshot/serve/recent questions; status remains the heavy health command.
- [ ] Skill documents the frozen `/doc?uri=` template and search/peek `absPath` open-file path (no content fetch).
- [ ] Live evidence: follow the skill's status-question recipe on a real index — run the named `gno peek --json` (and MCP `gno_peek` if the recipe names it) and save the output. Confirm the skill text matches those commands (no stale `status`+`ls`+`changes` composition for this job).

## Done summary
Pointed the skill and CLI/MCP docs at peek for snapshot, serve, and recent-file questions. Status remains the heavy activation/health command. Live `gno peek --json` and MCP `gno_peek` on the 1673-doc default index matched field-for-field (ignore generatedAt) and match the skill recipe; serve-up capture skipped (sibling resident lock) — covered by .1/.3 live evidence.

stage: impl-review - ran [conductor in-host, integrated diff 799aa1c2..b6d892b4] SHIP (model: claude-fable-5-thinking-high)
stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: b6d892b429b2e57ed04200836c99f606bfc543ce
- Tests: bun src/index.ts peek --json, bun /tmp/fn-119.4-qa/run-gno-peek-mcp.ts
- PRs: