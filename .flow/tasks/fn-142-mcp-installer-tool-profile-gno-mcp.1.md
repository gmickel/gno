---
satisfies: [R1, R2, R3, R4, R5]
---
# fn-142-mcp-installer-tool-profile-gno-mcp.1 Implement gno mcp install --tool-profile

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
Added `gno mcp install --tool-profile <core|full>`. The profile is written into the generated stdio registration as `--tool-profile <profile>` after `mcp` and before `--enable-write`, through the shared `buildMcpServerEntry` builder, so every installer target (all ten), both scopes, and the dry-run, force, and JSON paths carry it identically. Omitting the flag produces the pre-change registration byte for byte. Invalid values raise the runtime flag's validation error (exit 1) in `installMcp` before any config file is read or written. `gno mcp status` derives `toolProfile` from a registration's args (`full` when absent) and prints a Profile line and JSON field. Docs: docs/MCP.md (install block and Tool Profiles paragraph, replacing the "follow-up ships with a profile flag" promise), spec/cli.md (synopsis and options table), CLI help, CHANGELOG Unreleased.

Verification: `bun run lint:check` clean (one pre-existing warning in test/cli/query-text.test.ts); `bun test` 4852 pass / 2 skip / 0 fail on the committed tree (565 files); new test/cli/mcp-install-tool-profile.test.ts (8 tests: builder ordering, byte-identical default, args readback, dry-run JSON for all targets with write, installed registration and status readback, full when absent, --force switch, invalid profile rejected before any write). Live CLI: help shows the flag, dry-run JSON ends `mcp --tool-profile core --enable-write`, Codex TOML path carries it, invalid value exits 1, valid dry run exits 0. `bun run docs:verify`: 14 passed, 2 failed, 2 skipped; the two failures are the pre-existing README and legacy website/_config.yml version stamps (fn-140), unrelated.

Migration caveat: existing registrations are untouched and keep running `full`; switch with `gno mcp install --target <t> --tool-profile core --force`. Implemented in-harness: Grok was down and no cursor bridge was attempted.
## Evidence
- Commits: 0b9e7b5b74c0eb92fba067497e28d1901dcfe68a
- Tests: bun run lint:check (clean; 1 pre-existing warning), bun test (4852 pass, 2 skip, 0 fail; 565 files), bun test test/cli/mcp-install-tool-profile.test.ts (8 pass), bun run docs:verify (14 passed, 2 failed pre-existing version stamps, 2 skipped), gno mcp install --target claude-code --tool-profile core --enable-write --dry-run --json (args end: mcp --tool-profile core --enable-write), gno mcp install --tool-profile fast --dry-run (exit 1, validation message)
- PRs: