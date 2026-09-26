---
satisfies: [R1, R2, R3]
---
# fn-193-mcp-session-tools-read-a-stale-config.1 Implement MCP session tools read a stale config

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Reproduced first (R1): with a real stdio `gno mcp serve` and a real `gno serve` HTTP /mcp on an isolated GNO root, `gno_sessions_status` kept reporting `["codex-a"]` after the CLI added codex-b and removed codex-a. Fixed (R2): the fn-185 refresh moved to `src/sessions/config-refresh.ts` and is now shared by the REST route and the MCP tools. `gno_sessions_status` and `gno_sessions_import` re-read the config file on each call, with the same binding checks and errors: an unreadable config returns SESSIONS_RUNTIME_FAILURE and a rebound index returns SESSIONS_BINDING_MISMATCH, which is not adopted. Egress invalidation, which closes open HTTP MCP sessions, now runs only when the collection egress policy epoch changes, so a source-only CLI change no longer drops the caller's HTTP session. After the fix both transports report `["codex-a","codex-b"]` after the add and `["codex-b"]` after the remove. Tests (R3): `test/mcp/sessions-config-refresh.test.ts` covers stdio and the resident HTTP runtime (add and remove on one open session), plus the unreadable-config and rebound-index error cases. All four tests failed on the pre-fix code. The existing MCP import failure test now writes its broken config to the file.

Docs: docs/MCP.md, docs/SESSIONS.md, spec/mcp.md, CHANGELOG [Unreleased]. The matching gno.sh edit is on branch fn-193-mcp-sessions-config (worktree /home/gordon/work/gno-sh-fn193, commit 0c95616, committed locally but not pushed). QA evidence: .flow/tmp/qa-fn-193-mcp-session-tools-read-a-stale-config/{repro.ts,before.log,after.log}.

Follow-up: `gno_sessions_automation_run` already reads config from the path itself and was left unchanged.

baseline: none recorded pre-edit (the gates ran post-change: lint:check, docs:verify, full bun test green with TMPDIR outside the repo; /tmp tmpfs is at its user quota)

stage: impl-review - skipped(config: REVIEW_MODE=none, conductor instruction: no model review)
## Evidence
- Commits: d66cd1649845736c554d4ee2d74ed28723eee07c
- Tests: bun run lint:check, bun run docs:verify, TMPDIR=/home/gordon/.cache/gno-test-tmp/fn-193 bun test (5822 pass, 0 fail), bun test test/mcp/sessions-config-refresh.test.ts test/mcp/sessions.test.ts test/serve/sessions-api.test.ts test/sessions, bun .flow/tmp/qa-fn-193-mcp-session-tools-read-a-stale-config/repro.ts (real stdio + gno serve /mcp, before/after), gno.sh: bun run check, bun run typecheck, bun run test
- PRs: