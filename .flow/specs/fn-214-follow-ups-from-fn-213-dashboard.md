# Follow-ups from fn-213: dashboard overflow, inert MCP entry keys, stale flow config

## Goal & Context
<!-- scope: business; source: user -->

Three findings from the fn-213 run, fixed together before the next release. [user]

- On a phone-width screen (375 px) the dashboard's "Download missing models" button in the Bootstrap & Storage section ends at 382 px, so the page scrolls sideways (QA finding, filed in `.flow/memory/bug/ui/phone-width-user-sees-the-dashboard-2026-10-07.md`). [paraphrase]
- `gno mcp status` (and the connector verifier fed from it) reports any GNO registration carrying a key GNO does not write as "Malformed MCP server entry", for example `timeout` or Claude Code's `type: "stdio"`. Since fn-213, `gno mcp install --force` keeps such keys, so a repaired entry still shows as malformed. [paraphrase]
- `.flow/config.json` still carries keys flow-next 8 ignores (`land.release`, `land.reviewSignal`, `land.automatedReviewers`, `land.reviewTrigger`, `land.ciFixBudget`, `land.cleanReviewCommentPattern`, `land.requestReviewers`, `land.patienceMinutesAfterReview`, `artifacts.html.enabled`, `pipeline.chainStages`), and flowctl prints a notice about them on every call. [paraphrase]

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [paraphrase] At 375 px the Bootstrap & Storage header (title, description and the download button) fits the viewport: the document does not scroll horizontally, and the layout at desktop width is unchanged.
- **R2:** [inferred] `gno mcp status` reports a GNO registration as configured when its only extra keys are inert client settings that do not change how the command runs: `type` equal to `"stdio"`, numeric timeouts (`timeout`, `startup_timeout_sec`, `tool_timeout_sec`), a string `description`, string-array approval lists (`autoApprove`, `alwaysAllow`), and `enabled: true` / `disabled: false`. An entry with `enabled: false` or `disabled: true` reports as not configured, the way a disabled OpenCode entry already does. The same applies to OpenCode entries for `timeout`.
- **R3:** [inferred] Keys that change execution stay fail-closed exactly as today: `cwd`, a non-`stdio` `type`, `url`, `headers`, any other unknown key, and environment variables other than GNO's workspace keys still make the entry malformed for status and unsupported for the connector verifier. The verifier never runs an entry with keys outside the inert set.
- **R4:** [user] The ignored keys are removed from `.flow/config.json`; every key flowctl still reads keeps its value.

## Boundaries
<!-- scope: business -->

- [inferred] No change to what `gno mcp install` writes or keeps.
- [inferred] No other dashboard layout changes.

## Decision Context

The connector verifier starts the registered command, so status keeps its fail-closed rule for anything that could change the launch (fn-213 Implementation Notes). Only keys whose effect is limited to the client's own timeouts, labels and approval prompts are accepted. [inferred]

## Resolved via Codebase

- `src/serve/public/components/BootstrapStatus.tsx`: the header row is `flex items-start justify-between` with no wrap.
- `src/cli/commands/mcp/status.ts` `normalizeEntry`: rejects any key other than `command`, `args`, `env` (OpenCode: `type`, `command`, `enabled`, `environment`); `test/cli/mcp.test.ts` pins `cwd` as fail-closed.
- `src/core/connector-verifier.ts`: a `configError` target fails with `connector_unsupported_config`.
