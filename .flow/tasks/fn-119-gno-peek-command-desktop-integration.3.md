---
satisfies: [R3]
---
# fn-119-gno-peek-command-desktop-integration.3 Add read-only gno_peek MCP tool

## Description
Expose the same `peek@1.0` snapshot as a read-only, model-free MCP tool (`gno_peek`) so R3's agent surface matches CLI. Split from skill/user-docs so tool registration and live MCP invocation can land and be QA'd on their own.

**Size:** M
**Files:** spec/mcp.md; src/mcp/tools/peek.ts; src/mcp/tools/index.ts; src/mcp/http-egress.ts; test/mcp/tools/peek.test.ts; docs/MCP.md
**Touches:** spec/mcp.md; src/mcp/tools/peek.ts; src/mcp/tools/index.ts; src/mcp/http-egress.ts; test/mcp/tools/peek.test.ts; docs/MCP.md

### Approach
- Add `### gno_peek` in `spec/mcp.md` beside `### gno_status` (~1058): empty input object, output schema `gno://schemas/peek@1.0`, annotations read-only / not destructive. Same uninitialized-success and `RUNTIME` rules as R1.
- Implement `src/mcp/tools/peek.ts` by calling the shared builder from `src/core/peek.ts` (task 1). Follow `handleStatus` + `runTool` (`src/mcp/tools/status.ts:72`, `src/mcp/tools/index.ts`). Empty zod input like `statusInputSchema` (`src/mcp/tools/index.ts:667`).
- Register in `registerTools` (`src/mcp/tools/index.ts:1009`) with `MCP_TOOL_DESCRIPTIONS.peek`. Do **not** add to `MCP_WRITE_TOOL_NAMES`. Classify `gno_peek: "metadata"` in `src/mcp/http-egress.ts` next to `gno_status` (~59).
- Point agents at peek for cheap status/counts/backlog/recent/serve questions; leave `gno_status` for the heavy health/activation payload.
- Tests: `test/mcp/tools/peek.test.ts` after `test/mcp/tools/status.test.ts` (mock ctx + real-store if the suite has one). Assert structuredContent validates against peek schema; uninitialized is success; handler never calls embed/model/activation APIs.
- User MCP doc: add `gno_peek` to the read-tool list and a short section in `docs/MCP.md` (~32, ~1278).

### Investigation targets
**Required** (read before coding):
- `src/mcp/tools/status.ts`
- `src/mcp/tools/index.ts`
- `spec/mcp.md`
- `test/mcp/tools/status.test.ts`
- `src/mcp/http-egress.ts`
- `docs/MCP.md`
**Optional**:
- `src/mcp/context.ts`
- `test/mcp/http-parity.test.ts`
- `src/core/peek.ts`

### Key context
R3's `spec/cli.md` + peek schema + contract tests landed in task 1 — do not fork a second snapshot shape. MCP stdio already has a store; uninitialized-without-store must still return the success `initialized:false` payload, not `gno_status`'s throw path. Never HTTP-probe serve.

## Acceptance
- [ ] `gno_peek` is registered, read-only, model-free, and returns the same `peek@1.0` structuredContent as `gno peek --json`.
- [ ] `spec/mcp.md` + `docs/MCP.md` document the tool; egress class is `metadata`; not in the write-tool set.
- [ ] Live evidence: real MCP `gno_peek` invocation against a real index (initialized and serve up or down). Save the structuredContent JSON next to a `gno peek --json` capture from the same index and confirm field-level match (ignore `generatedAt`).

## Done summary
Added read-only `gno_peek` MCP tool that returns the shared `peek@1.0` snapshot via `buildPeekSnapshot`. Registered as metadata/not-write, documented in spec/mcp.md and docs/MCP.md. Live MCP vs `gno peek --json` matched field-for-field (ignore generatedAt) on a temp index and the real 1673-doc default index (serve down); conductor re-verified the real-index parity from the raw artifacts in /tmp/fn-119.3-qa/.

stage: impl-review - ran [conductor in-host, integrated diff b89d10a8..301320b4] SHIP (model: claude-fable-5-thinking-high)
stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 301320b4cf8441b0204f62978c0c828b3339e918
- Tests: bun test test/mcp/tools/peek.test.ts, bun test test/egress/enforcement.test.ts, bun test test/mcp/http-parity.test.ts, bun test test/mcp/tools/peek.test.ts test/egress/enforcement.test.ts test/mcp/http-parity.test.ts (integrated target, 26/26), live-qa: real-index MCP structuredContent == CLI payload field-for-field incl recent[] (conductor re-verified, /tmp/fn-119.3-qa/)
- PRs: