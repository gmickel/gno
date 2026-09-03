---
satisfies: [R1, R4, R5, R7]
---
# fn-130-memory-slice-rememberrecall-contracts.3 MCP surface: gno_recall + gno_remember

## Description
MCP surface. **Size:** M. **Files/Touches:** src/mcp/tools/memory-recall.ts + memory-remember.ts, src/mcp registry, spec/mcp.md, docs/MCP.md, test/mcp/memory*.
`gno_recall` in the read registry; `gno_remember` gated by --enable-write. Adapters delegate to the core service and DO NOT take ctx.writeLockPath (core owns the lease — see task 1 contract). Recall/remember inputs carry caller+session identity per the core contract (MCP session identity mapped from server session). Tool descriptions written as when-to-call micro-instructions meeting the site copy rules. NOTE dependency direction: fn-131 lands after this spec and adds gno_recall to its core profile; this task ships the tools into today's full registry only.

**Touches:** src/mcp/tools/memory-recall.ts (new), src/mcp/tools/memory-remember.ts (new), src/mcp registry, spec/mcp.md, docs/MCP.md, test/mcp/memory*

## Acceptance
- [ ] gno_recall listed without write flag; gno_remember only with --enable-write (live MCP client listing)
- [ ] Live MCP loop: remember(add) → recall returns the fact with cite + receipt; fence rejects replay via MCP
- [ ] No writeLockPath acquisition in the memory tools (code assertion/test); concurrent MCP remember + CLI writer serialise via core lease
- [ ] Descriptions pass the copy rules; spec/mcp.md updated in the same change

## Done summary
Shipped the MCP memory surface: `gno_recall` in the read registry and `gno_remember` behind `--enable-write`, both thin adapters over the core `MemoryService` (`src/mcp/tools/memory-recall.ts`, `src/mcp/tools/memory-remember.ts`, registered in `src/mcp/tools/index.ts`, `gno_remember` added to `MCP_WRITE_TOOL_NAMES`, both classified `source` in `MCP_HTTP_EGRESS_TOOLS`). Identity is mapped from the MCP session (caller = client `initialize` name, session = Streamable HTTP session id or the stdio server instance id); tool arguments never carry identity. The adapters pass `ctx.writeLockPath` to the service as the lease path and acquire no lock themselves. `MemoryError` codes surface as `structuredContent.error`; a disabled-write dispatch returns `WRITE_DISABLED`. Tool descriptions are when-to-call micro-instructions (mechanism first, honest bounds: 8 facts / 512 tokens default, superseded excluded, fence limits). spec/mcp.md gained `gno_recall` / `gno_remember` sections, the lease note, and the error-code list; docs/MCP.md gained both tool sections and registry-true tool counts (34 read-only + 19 write = 53; the prior 22/15/37 text was stale).

Tests (`test/mcp/memory.test.ts`, 10 tests): write-set membership + egress class; live in-memory MCP client listing (gno_recall without the flag, gno_remember only with it, annotations + descriptions); WRITE_DISABLED on direct disabled dispatch; empty recall hint + receipt identity; remember(add) -> recall returns the fact with `gno://` cite, spanHash in receipt, default budget -> replay with receipt rejected `MEMORY_FENCED_REPLAY`, gno:// derivedFrom rejected `MEMORY_FENCED_DERIVED`; exact duplicate returns `existing` without a content mutation; R4 unscoped calls fail and unmanaged collection returns `MEMORY_COLLECTION_UNMANAGED` on both tools; adapter sources import no lock primitives; a pre-held external lease holds the MCP remember until release, then it succeeds (core lease serialisation), and a recall with blank client name / HTTP session id maps to `mcp` / that session.

Scope note: MCP recall runs the lexical leg only (`retrieval.mode: "lexical"`); wiring the vector leg means loading an embedding model per call as `gno_vsearch` does, which contradicts recall's fast-path contract - follow-up noted in NOTES_DIR (`fn-130-3-mcp-memory.md`) along with the identity mapping and payload-shape notes for .4. CHANGELOG.md untouched (outside Touches). First full-suite run failed one task-caused test (`test/egress/enforcement.test.ts` requires an egress class per registered tool) - fixed in the second commit.

baseline: green via handoff (verified at 48488e5d by fn-130-memory-slice-rememberrecall-contracts.1)
verify: `flowctl gate classify` -> FULL (spec/mcp.md unmatched); `bun run lint:check` green (1 pre-existing warning in test/cli/query-text.test.ts, not this task); full `bun test` green at HEAD b127778a (4582 pass, 2 skip, 0 fail, 181.8s, suite_rc=0); green receipt `.flow/tmp/green-receipts/b127778a-unittest.json`.

stage: impl-review - skipped(policy: parallel-wave - conductor owns the review after integration)

Integrated onto the spec branch as e1fad78c + 44316bd1 (cherry-pick over the .2 CLI commit).

stage: impl-review - skipped(policy: review backend none)
stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: e1fad78c6521389c1192903486378cdfc58278a4, 44316bd14e72b66aa124bd83219ce59549d9691f
- Tests: bun test test/mcp/memory.test.ts, bun test test/mcp, bun test test/mcp/memory.test.ts test/egress/enforcement.test.ts, bun run lint:check, bun test, integrated: bun test test/mcp/memory.test.ts test/cli/memory.test.ts test/egress/enforcement.test.ts
- PRs: