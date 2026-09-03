---
satisfies: [R4, R5]
---
# fn-131-slim-mcp-core-tool-profile-and-mcp-2026.3 Core tool descriptions as micro-instructions + docs

## Description
Core-profile descriptions + docs. **Size:** S. **Files/Touches:** NEW core-profile description variants (separate table — full profile keeps ORIGINAL strings verbatim for byte-compat, per task 1 snapshot), spec/mcp.md, docs/MCP.md, skill/playbook routing text if it drifts (NO autoresearch eval — operator default).
Core set descriptions rewritten as when-to-call micro-instructions meeting the copy rules; alignment check between playbook routing advice and descriptions; document the deferred default-flip decision.

**Touches:** core-profile description variants module (new), spec/mcp.md, docs/MCP.md, assets/skill routing text (if drifted)

## Acceptance
- [ ] Core descriptions are variants; full profile byte-compat test still green
- [ ] Copy-rule pass recorded on new descriptions; playbook/descriptions agree
- [ ] spec/mcp.md + docs/MCP.md updated incl. default-flip deferral

## Done summary
Served when-to-call micro-instructions for the nine core-profile tools from a separate variants table, while `full` keeps every original description string verbatim; documented both profiles, the negotiated protocol revisions, and the deferred default flip; folded the whole fn-131 slice into one CHANGELOG entry.

Implementation:
- `src/mcp/tool-descriptions-core.ts` (new): `MCP_CORE_TOOL_DESCRIPTIONS` keyed by tool name for gno_query, gno_search, gno_get, gno_multi_get, gno_context, gno_changes, gno_recall, gno_capture, gno_remember; `profileToolDescription(profile, name, full)` returns the original for `full` and for any tool the table does not name; `MCP_CORE_TOOL_NAMES` = read set + write allowlist.
- `src/mcp/tools/index.ts`: `registerTools` resolves the profile once and wraps the nine registration sites in `describe(name, original)`; `MCP_TOOL_DESCRIPTIONS` and the two inline strings (gno_changes, gno_capture) are untouched, so the legacy golden and the tool-profile byte-compat pin stay green. Input schemas and annotations are shared across profiles. No protocol or profile-mechanism change.
- Each core description opens with when to call, names the mechanism (hybrid fusion + one-hop graph; BM25 only; line-range read; batch read with maxBytes; deterministic Capsule within budgetTokens; metadata-only change records with cursors; scoped recall; capture receipt + separate embed step; remember decision flow), then what comes back and the bound to respect.

Copy-rule pass (recorded): rules located in the vault `human-writing` skill (`~/work/GordonsVault/.claude/skills/human-writing/SKILL.md`) and the fn-133 spec summary (positive frames, mechanism-first, no promotional vocabulary, no negative parallelism, honest bounds). Applied to all nine strings: no "not X, Y" / "never X" framings (two "never" bounds rewritten as positive statements), no promotional or AI-vocabulary words, active voice with the caller as actor, numbers named (8 facts / 512 tokens, limit 100 / max 1000, one-hop graph). `test/mcp/tool-descriptions-core.test.ts` pins the shape per tool: starts with "Call ", says what returns, rejects the banned patterns, <= 900 chars.

Playbook alignment: SKILL.md retrieval order and mcp-reference.md "Retrieval Order" already route exactly as the descriptions say (gno_query first, gno_search for exact words, gno_get fromLine/lineCount, gno_multi_get batching, gno_context for one bounded handoff, gno_changes for what changed, recall/remember for facts). One drift found: neither file mentioned tool profiles, so an agent on `core` would read routing steps naming tools it cannot see. Added one sentence to each naming the core set and stating the remaining steps apply under `full`. No autoresearch eval run (operator default). Inherited, untouched: the `.claude/skills/gno` and `.codex/skills/gno` mirrors were already stale for four files (cli-reference, README, SKILL, mcp-reference) before this task; `scripts/docs-verify.ts` is not a test gate. Follow-up: resync the mirrors in one sweep.

Docs: spec/mcp.md "Tool Profiles" (description variants + table/test names, both revisions negotiated in both profiles, explicit deferred default-flip decision with the evidence it waits on and the `gno mcp install` profile flag as part of that follow-up); docs/MCP.md Tool Profiles (same, plus the playbook mapping and a link to the transport section); src/mcp/{CLAUDE,AGENTS}.md file tree; CHANGELOG [Unreleased] rewritten into one fn-131 entry (profiles, core descriptions, 2026-07-28 dual-speak, SDK 2.0.0 runtime; SDK wire deltas stay under Changed). Website (~/work/gno.sh) not touched (fn-133).

Tests: test/mcp/tool-descriptions-core.test.ts (12: table == core set; full listing == golden and core differs on exactly the core set; pass-through for full/unlisted; per-tool copy-rule shape). The shape test was observed red first (gno_capture said "returns" in lower case; the matcher was made case-insensitive, the description left as written).

baseline: green via handoff (verified at f54e22c3 by fn-131-slim-mcp-core-tool-profile-and-mcp-2026.2); lint:check rc=0 pre-edit (1 inherited oxlint warning in test/cli/query-text.test.ts, not this task)
gate: gate classify FULL (assets/skill/SKILL.md unmatched); bun run lint rc=0; bun test rc=0 (4687 pass / 2 skip / 0 fail, 547 files, 181s) at 9697c48f; GREEN_RECEIPT .flow/tmp/green-receipts/9697c48f-unittest.json

stage: impl-review - skipped(config: REVIEW_MODE=none)
## Evidence
- Commits: 9697c48f2f8fffc976996463aa2d3491b2a643bd
- Tests: bun test test/mcp/tool-descriptions-core.test.ts test/mcp/tool-profile.test.ts test/mcp/legacy-parity.test.ts test/mcp/memory.test.ts test/mcp/protocol-2026.test.ts, bun run lint, bun test
- PRs:
stage: plan-sync - skipped(config: planSync.enabled != true)
