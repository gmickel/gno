---
satisfies: [R1, R2, R6]
---
# fn-131-slim-mcp-core-tool-profile-and-mcp-2026.1 Tool-profile mechanism + core membership decision

## Description
Tool-profile mechanism + membership decisions. **Size:** M. **Files/Touches:** src/mcp/server.ts + registry, src/serve HttpGatewayConfigSchema + HttpGatewayOverrides + serve/daemon CLI wiring + detached-child argv, spec/mcp.md (profile section), test/mcp/profile*.
Profile selection: CLI `gno mcp --tool-profile core|full`; resident gateway config key `gateway.toolProfile` (HttpGatewayConfigSchema mounts under root key `gateway`); serve/daemon CLI override `--mcp-tool-profile`; precedence: CLI flag > config > default `full`; applies on listener start (restart to change, documented). Runs on the POST-MIGRATION SDK (depends on task 4). Core READ set (decided against the skill playbook's routing advice, ≤7): gno_query, gno_search, gno_get, gno_multi_get, gno_context, gno_changes, gno_recall (present — fn-130 lands first; spec dependency now encoded). Core WRITE set with --enable-write is an EXACT allowlist: gno_capture, gno_remember, plus gno_job_status iff any exposed write is async (no unpollable jobs). full = byte-identical registry AND descriptions to today. Tests: profile selection, write gate never weakened, full-profile byte-compat snapshot.

**Touches:** src/mcp/server.ts, src/mcp registry module, src/serve gateway config schema + serve/daemon CLI wiring + detached-child argv, spec/mcp.md (profile section), test/mcp/profile*

## Acceptance
- [ ] Live MCP listing: core shows exactly the documented read set; +write shows exactly the write allowlist; full is byte-identical to pre-change snapshot (descriptions included)
- [ ] Config key + CLI flag + precedence + restart semantics implemented and documented; resident gateway honors profile for all clients
- [ ] Write tools never appear without --enable-write in either profile (test)
- [ ] Exact allowlists recorded in spec/mcp.md

## Done summary
Added MCP tool profiles (`core` | `full`, default `full`) for the stdio server and the resident gateway, with the core membership decided and recorded in spec/mcp.md.

Membership decision:
- Core read set (7): gno_query, gno_search, gno_get, gno_multi_get, gno_context, gno_changes, gno_recall.
- Core write allowlist with --enable-write (exact): gno_capture, gno_remember. gno_job_status is excluded from both core sets because neither exposed write is asynchronous (neither handler starts a JobManager job; capture returns after the file write, remember returns once the fact is lexically searchable), so core never hands out a job ID. Reasoning recorded in spec/mcp.md "Tool Profiles".
- `full` is byte-identical to the previous registry: the registrar returns `server.registerTool` itself for full, so order, names, descriptions, annotations, and schemas are unchanged; test/mcp/legacy-parity.test.ts stays green and test/mcp/tool-profile.test.ts pins explicit-full == unprofiled-default == golden (descriptions included). Descriptions are shared between profiles for now (task .3 owns the rewrite; full keeps the original strings verbatim).

Mechanism:
- src/mcp/tool-profile.ts (new, ~90 LOC): profile enum, allowlists, `parseMcpToolProfile`, `createProfileToolRegistrar` (skips registration outside the profile; tools outside the profile answer JSON-RPC -32602 like an unregistered tool).
- `ToolContext.toolProfile` (optional; full when absent) read by `registerTools`; `startMcpServer` and `createMcpHttpGateway` set it.
- Selection: `gno mcp --tool-profile core|full`; `gateway.toolProfile` in HttpGatewayConfigSchema (root key `gateway`); `gno serve|daemon --mcp-tool-profile`. Precedence in `resolveHttpGatewayConfig`: CLI flag > config > default full. Applied at listener start; restart to change (documented). `--detach` re-execs the same argv so the child inherits the flag (live-verified). Invalid values fail with VALIDATION before any side effect (pid files, NODE_ENV, detach, runtime boot).
- Write gate untouched: `MCP_WRITE_TOOL_NAMES`, `ctx.enableWrite`, and the HTTP `containsUnauthorizedWrite` check are unchanged; a profile only narrows what the gate exposes (test: write tools never appear without --enable-write in either profile).

Live verification (real @modelcontextprotocol/client): stdio `gno mcp` core -> exactly the 7 read tools; core + --enable-write -> 7 + gno_remember, gno_capture; full -> 34 / 53. `gno daemon --mcp-tool-profile core` (with and without --mcp-enable-write), `gateway.toolProfile: core` without a flag, and `--mcp-tool-profile full` overriding config core all listed the expected sets over Streamable HTTP; a `--detach` daemon child listed the core set.

Found and fixed during live verification: the first pass forgot to forward `toolProfile` in the explicit override objects daemon.ts and serve/server.ts build for `resolveHttpGatewayConfig` (flag silently fell back to config/full). Regression test test/mcp/tool-profile-gateway.test.ts covers both entry points (confirmed red without the wiring). A second full-suite red (12 web UI DOM tests) was traced to the new smoke test hitting `gno serve` with an invalid profile after the serve action had already set `process.env.NODE_ENV`; fixed at the root by validating the flag before any serve/daemon side effect.

Docs: spec/mcp.md (Tool Profiles section, exact allowlists, precedence, restart semantics, deferred default flip), docs/MCP.md, docs/CLI.md, docs/CONFIGURATION.md, CHANGELOG [Unreleased]. Not touched (task .3 / downstream): assets/skill, ~/work/gno.sh website; `gno mcp install` has no profile flag (not in the AC; follow-up candidate).

Tests: test/mcp/tool-profile.test.ts (9), test/mcp/tool-profile-gateway.test.ts (2), test/cli/smoke.test.ts (+3). Inherited, untouched: one pre-existing oxlint warning in test/cli/query-text.test.ts.

baseline: green via handoff (verified at aa569a36 by fn-131-slim-mcp-core-tool-profile-and-mcp-2026.4); lint:check rc=0 pre-edit
gate: bun run lint:check rc=0; bun test rc=0 (4650 pass / 0 fail, 544 files) at a1efaca6; GREEN_RECEIPT .flow/tmp/green-receipts/a1efaca6-unittest.json
stage: impl-review - skipped(config: REVIEW_MODE=none)
## Evidence
- Commits: a1efaca6b2d95cd27280bb05cf09a4b9bf33e249
- Tests: bun run lint:check, bun test (4650 pass / 0 fail, 544 files), bun test test/mcp/tool-profile.test.ts test/mcp/tool-profile-gateway.test.ts test/cli/smoke.test.ts test/mcp/legacy-parity.test.ts, live: real MCP client listings over stdio (gno mcp) and Streamable HTTP (gno daemon incl. --detach child) in core/full with and without --enable-write
- PRs:
stage: plan-sync - skipped(config: planSync.enabled != true)
