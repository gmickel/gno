---
satisfies: [R1, R2, R3, R4]
---
# fn-185-session-archive-polish-after-first.1 Implement Session archive polish after first release

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Session archive polish: a running `gno serve` adopts CLI `sessions source add/remove` on the next status request (refreshed before the resident read is admitted, binding-checked, unreadable config reported as `SESSIONS_RUNTIME_FAILURE`), and Remove succeeds for a source already unregistered. Enter on "Discover local sources" moves focus to a "Discovery results" region; `gno ls --json` and `gno ask --json` `meta.answerContext` URIs carry `?index=`; docs/SESSIONS.md, docs/API.md, CHANGELOG and the gno.sh copy explain `pending` versus the other unit counts. The production SPA snapshot was rebuilt so the focus fix ships.

Tests: R1 test/serve/sessions-api.test.ts (CLI changes, unreadable config, rebound config, status route epoch); R2 test/serve/public/sessions-page.test.tsx (Enter on Discover); R3 test/spec/schemas/ask.test.ts (answerContext/citations/results) and test/cli/sessions.test.ts (ls --json). Live QA evidence in .flow/tmp/qa-fn-185-session-archive-polish-after-first/. gno.sh branch fn-185-sessions-polish (worktree ~/work/gno-sh-fn185, commit 2656a06, not pushed).

Tier: session (actual model: claude-opus-5-5)

stage: impl-review - ran (codex gpt-6-astra: round 1 NEEDS_WORK with 3 findings, fixed; round 2 SHIP)
## Evidence
- Commits: 0ac558bda81a28184c493415f427953d7e4fd33f, 1693a3d4b5192f6f2bedeead89fe97b92ec8e2e4, a1db5644f8d93718ee67e1149dcdef9635d2aec1
- Tests: baseline: none (spec defines no Quick commands), mise exec bun@1.4.2 -- bun test (full: 5797 pass, 2 skip, 0 fail), mise exec bun@1.4.2 -- bun run lint:check, bun test test/serve/sessions-api.test.ts test/serve/public/sessions-page.test.tsx test/spec/schemas/ask.test.ts test/cli/sessions.test.ts test/serve/spa-snapshot-freshness.test.ts, live QA: .flow/tmp/qa-fn-185-session-archive-polish-after-first/
- PRs: