---
satisfies: [R1, R2, R3, R4]
---
# fn-214-follow-ups-from-fn-213-dashboard.1 Implement Follow-ups from fn-213

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Implemented fn-214 R1–R4.

- R1: the Bootstrap & Storage header stacks below `sm` (button `self-start`), so at 375 px the document is 375 px wide (was 382) and the desktop layout is unchanged. Rebuilt the committed SPA snapshot and built CSS.
- R2/R3: `gno mcp status` accepts inert client keys (`type: "stdio"`, numeric `timeout`/`startup_timeout_sec`/`tool_timeout_sec`, string `description`, string-array `autoApprove`/`alwaysAllow`, boolean `enabled`/`disabled`; OpenCode numeric `timeout`). A disabled entry is not configured without an error, for any format. `cwd`, non-stdio `type`, `url`, `headers`, unknown keys, wrong value types and non-workspace env keys stay "Malformed MCP server entry" and unverifiable. The runtime check skips `disabled: true` entries too.
- R4: removed the ten keys flow-next 8 ignores from `.flow/config.json`; flowctl no longer prints the notice, and `land.patienceMinutes`, `land.mergeVerdictCommand`, `pipeline.qa` and `review.*` keep their values.

Live QA (sandbox): header measured twice at 375 and 1280; `gno mcp status` on real Claude Code configs for the inert, disabled and fail-closed cases; a `--force` repair that keeps `type`/`timeout` now shows as configured.

stage: impl-review - skipped(config: review.backend=none; repository rule skips review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: f9a0a165d6d08b6a97425f9b69a62b53708fcd0a, 1b9a0a3753cb0ac7fba0d05d4f906439aca7a0b6, ce036a0c884329f300c4aa4765bf74644e963791, 726144cfbb30e6e432c69696e969fdfb3ebc7b3b
- Tests: bun run lint:check && bun test, bun test test/cli/mcp.test.ts test/serve/spa-snapshot-freshness.test.ts
- PRs: