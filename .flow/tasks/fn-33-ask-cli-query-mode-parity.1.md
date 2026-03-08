# fn-33-ask-cli-query-mode-parity.1 Add query mode support to gno ask CLI

## Description

TBD

## Acceptance

- Add repeatable `--query-mode <mode:text>` to `gno ask`.
- Reuse existing query-mode parser/validation and reject duplicate `hyde`.
- Pass `queryModes` into Ask retrieval pipeline.
- Add CLI coverage for valid and invalid cases.
- Update docs/spec to document the flag and behavior.

## Done summary
Added CLI `gno ask --query-mode` parity with the existing Ask API/Web support. The ask command now accepts repeatable `term|intent|hyde` query modes, reuses the shared parser/validation path, and surfaces query-mode summary metadata in JSON output.
## Evidence
- Commits:
- Tests: bun run lint:check, bun test, bun /Users/gordon/work/gno/src/index.ts ask "performance" --query-mode term:"web performance budgets" --query-mode intent:"latency and vitals" --no-answer --json
- PRs: