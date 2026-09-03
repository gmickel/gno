## Goal & Context

`gno mcp --tool-profile core|full`, `gno serve --mcp-tool-profile`, `gno daemon --mcp-tool-profile`, and `gateway.toolProfile` select the advertised MCP tool set at runtime (fn-131). The installer does not: `gno mcp install` writes stdio registrations that always start `gno mcp` on the default `full` profile, so a user who wants the 7-tool core surface in Claude Code, Cursor, Codex, or any other target has to hand-edit the generated config. The installer is the one place the profile choice should be made once per harness.

## What

- `gno mcp install --tool-profile <core|full>`. The generated stdio registration carries `--tool-profile <profile>` after `mcp`, alongside `--enable-write` when that flag is set. Omitting the flag keeps today's output byte-for-byte (`full`, no flag emitted), so existing registrations and the public-truth locks stay unchanged.
- Every installer target (`gno mcp install --target <t>`, all ten plus any alias), every scope, and the `--dry-run`, `--force`, and `--json` paths carry the profile the same way, because they all flow through the one server-entry builder.
- Invalid values fail the same way the runtime flag does: the shared `parseMcpToolProfile` error, exit 1, before any file is touched.
- `gno mcp status` shows the profile a registration carries (read from its args) so drift is visible.
- Docs: `docs/MCP.md` install section and Tool Profiles, `spec/cli.md` for `gno mcp install`, CLI help, CHANGELOG Unreleased.

## Acceptance Criteria

- R1: `gno mcp install --target claude-code --tool-profile core --dry-run --json` shows args ending `mcp --tool-profile core`; with `--enable-write` too, both flags are present.
- R2: `gno mcp install` without the flag produces exactly the registration it produced before this change (no `--tool-profile` token).
- R3: `--tool-profile fast` (or any other value) exits 1 with the shared validation message and writes nothing, for `--dry-run` and real installs alike.
- R4: Unit tests cover the entry builder (profile with and without write), the CLI option parsing across targets, and the status readback.
- R5: `docs/MCP.md`, `spec/cli.md`, CLI help text, and CHANGELOG reflect the flag; `bun run lint:check` and `bun test` green.

## Boundaries

- Out: changing the default profile; migrating existing registrations automatically (users rerun `gno mcp install --force --tool-profile core`).
- Out: `gno skill install` or the agents block.
