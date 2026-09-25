---
satisfies: [R1, R2]
---
# fn-183-error-schema-lists-the-cli-busy-code.1 Implement Error schema lists the CLI BUSY code

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
`error.schema.json` now lists every CLI error code, including `BUSY`. `CliErrorCode` is derived from a runtime `CLI_ERROR_CODES` list in src/cli/errors.ts, and test/spec/schemas/error.test.ts fails if the schema enum and that list diverge (R1 error case). test/cli/sessions.test.ts holds the sessions import lock, runs a real `sessions import --json`, and validates the resulting exit-4 BUSY envelope against the schema (R1). spec/cli.md's exit-code table and Error Output section now list all eight codes with their exit codes and say which ones write an envelope (R2). CHANGELOG has an Unreleased Fixed entry. docs/CLI.md, docs/TROUBLESHOOTING.md and gno.sh already name BUSY where they list codes, so they are unchanged. Both new tests were confirmed red against the old schema.

baseline: green (focused error-schema + sessions tests)
Tier: session (actual_model: claude-opus-5-5)

stage: impl-review - ran (codex gpt-6-astra medium, 3-draw fan-out, SHIP first round)
## Evidence
- Commits: a1bd012dc8f2feb073fe819ff3547bbae71f1a60
- Tests: mise exec bun@1.4.2 -- bun test test/spec/schemas/error.test.ts test/cli/sessions.test.ts, mise exec bun@1.4.2 -- bun test, mise exec bun@1.4.2 -- bun run lint:check, mise exec bun@1.4.2 -- bun run docs:verify
- PRs: