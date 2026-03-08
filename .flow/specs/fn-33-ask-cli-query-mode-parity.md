# Ask CLI query mode parity

## Goal

Close the remaining Ask parity gap by exposing structured `queryModes` on the CLI `ask` command, matching the existing Ask API and Ask Web UI support.

## Scope

- Add repeatable `--query-mode <mode:text>` to `gno ask`.
- Reuse the same parser/validation as `gno query`.
- Pass parsed `queryModes` into Ask command/search pipeline.
- Update CLI docs/spec and smoke coverage.

## Acceptance

- `gno ask --query-mode ...` accepts `term`, `intent`, and `hyde` entries.
- CLI rejects invalid mode specs and duplicate `hyde` entries.
- `gno ask --query-mode ... --no-answer --json` returns `meta.queryModes` and `expanded: true`.
- Docs/spec reflect the new flag.
