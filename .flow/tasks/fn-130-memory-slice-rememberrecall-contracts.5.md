---
satisfies: [R5, R6, R7, R8]
---
# fn-130-memory-slice-rememberrecall-contracts.5 Fence loop verification + docs/MEMORY.md + exclusion audit

## Description
Fence loop verification + docs + exclusion audit. **Size:** S. **Files/Touches:** docs/MEMORY.md (new), CHANGELOG.md, test fence e2e.
End-to-end fence test live on CLI and MCP; docs/MEMORY.md covers taxonomy (edit vs capture vs remember), scopes (any-intersection semantics), supersession, fencing honesty incl. paraphrase limits and derivedFrom; CHANGELOG. R8 exclusion audit: verify none of the excluded behaviors exist (no auto-capture, no LLM adjudication, no delete path, no implicit global scope).

**Touches:** docs/MEMORY.md (new), CHANGELOG.md, test fence e2e (new file)

## Acceptance
- [ ] Fence e2e green on CLI and MCP (recall → replay remember rejected; derivedFrom rejected)
- [ ] docs/MEMORY.md ships the full taxonomy + honesty notes; CHANGELOG entry present
- [ ] Exclusion audit recorded with evidence (grep/test) for each R8 item

## Done summary
Closed the memory slice: a live fence e2e on CLI and MCP (`test/memory-fence-e2e.test.ts`), the new `docs/MEMORY.md` (taxonomy, scopes, supersession, fencing honesty, exclusions), one coherent memory-slice CHANGELOG entry, a README pointer, and `remember` / `recall` rows in the CLI `CMD` / `FORMAT_SUPPORT` registry (allowed extra b; the .2 note was still accurate). No defect surfaced in core/CLI/MCP memory code, so allowed extra (a) was not used.

Fence e2e (R6, 8 tests): one temp GNO home; the CLI stores a fact, then each surface recalls it and (1) replays the recalled span with the receipt -> `MEMORY_FENCED_REPLAY`, (2) remembers a paraphrase with `derivedFrom: [gno://...]` -> `MEMORY_FENCED_DERIVED`; an MCP-issued receipt fences the CLI and a CLI receipt fences MCP; the memory directory is byte-identical before/after each rejection; a paraphrase with no receipted span and only a non-GNO origin is stored (the documented limit, pinned so the doc stays honest). Verification test of shipped behavior: green on first run (the per-surface fence tests from .2/.3/.4 were the red-to-green ones).

docs/MEMORY.md (R7): four-surface table with links, edit/capture/remember taxonomy with the 4096-byte fact bound, memory-managed setup (config edit, no CLI flag yet), the fact-file contract (frontmatter, contentHash = span hash, `relations.supersedes` typed edge, malformed-file handling), scopes (1-8, normalization, character rules, any-intersection, in-query filtering, no implicit global scope, not an ACL), identity per surface, remember outcomes table and supersession protocol with the conflict rule, recall budget/retrieval/hint, context fencing with receipt fields and a plain "a paraphrase without lineage cannot be fenced" section, concurrency/lease, MEMORY_* code table (CLI exit + HTTP), "What memory does not do" (the R8 list), binding defaults.

R8 exclusion audit (evidence: grep over `src/` at f69e5f69 + tests):
- No automatic turn capture: `grep -rln "MemoryService\|\.remember("` src -> only src/core/memory.ts, src/cli/commands/memory.ts, src/mcp/tools/memory-{recall,remember}.ts, src/serve/routes/api.ts, src/sdk/client.ts (the four explicit adapters); `grep -rn -iE "auto.?capture|on.?turn|afterTurn|autoRemember"` src -> no matches. Every write is an explicit call (test/cli/memory.test.ts "no decision ... writes nothing"; fence e2e asserts the file list is unchanged on every rejection).
- No LLM extraction/adjudication: `grep -n -iE "GenerationPort|createGenerationPort|generate|RerankPort|rerank|adjudic|extract|consolidat"` src/core/memory.ts src/cli/commands/memory.ts src/mcp/tools/memory-*.ts -> no matches; the only llm import in the memory path is `EmbeddingPort`/`LlmAdapter.createEmbeddingPort` (ranking candidates). Likely matches return `outcome: "candidates"` and write nothing (test/cli/memory.test.ts, test/mcp/memory.test.ts, test/spec/schemas/memory-contract.test.ts).
- No consolidation: same grep, `consolidat|dedup` -> no matches in memory modules; supersession is the only reduction (test/core/memory.test.ts, CLI/SDK supersede tests).
- No delete/forget: `grep -n -iE "unlink|\brm\b|delete|forget|remove"` src/core/memory.ts src/core/memory-record.ts src/core/memory-diagnostics.ts src/cli/commands/memory.ts src/mcp/tools/memory-*.ts -> no matches; `grep -n -i memory src/serve/routes/api.ts | grep -iE "delete|forget"` -> no matches (only `/api/memory/remember|recall` exist). Superseded records stay on disk and are excluded in-query (CLI test "supersede ... hides the predecessor").
- No memory web UI: `grep -rln -iE "remember|recall|api/memory"` src/serve/public -> only CaptureModal.tsx, and that hit is the comment "Remembers last used collection" (no memory UI surface).
- No implicit global scope: `MEMORY_SCOPES_REQUIRED` thrown in src/core/memory.ts:271,278 ("there is no implicit global scope"); CLI src/cli/commands/memory.ts:108 and MCP src/mcp/tools/memory-recall.ts:50 repeat it; R4 tests on CLI, MCP, REST, SDK, and core assert unscoped calls fail.
- No cross-machine coordination: `grep -n -iE "remote|peer|replicat|ssh|http"` src/core/memory.ts -> no matches; the only lease is the local `.mcp-write.lock`.
- No harness adapters: `grep -rln -iE "openclaw|hermes"` src -> src/cli/program.ts, src/cli/commands/agents/harnesses.ts, src/cli/commands/skill/paths.ts, src/serve/connectors.ts, none of which reference memory/remember/recall (`grep -n -i "memory|remember|recall"` on those files -> no matches); they are the fn-129 `gno agents` instruction installer and skill paths.

baseline: none (the spec lists no Quick commands; siblings' green handoff at 48488e5d plus the full run below stand in)
verify: `flowctl gate classify --base 027f64d3` -> FULL (src/cli/options.ts); focused `bun test` over the six memory/options files -> 72 pass, suite_rc=0; full `bun test` -> 4628 pass, 2 skip, 0 fail (180.3s, suite_rc=0), green receipt `.flow/tmp/green-receipts/f69e5f69-unittest.json`; `bun run lint:check` rc 0 (one pre-existing await-thenable warning in test/cli/query-text.test.ts:26, not this task).
notes: /home/gordon/work/gno/.git/flow-notes/fn-130-20260903-run1/fn-130-5-docs-fence.md (anchors to re-check on the hosted site, follow-ups not built: `collection add --memory-managed`, MCP vector leg, CLI/MCP rows in the cross-surface contract test, gno.sh memory pages).

stage: impl-review - skipped(policy: parallel-wave - conductor owns the review after integration)

stage: impl-review - skipped(policy: review backend none)
stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: f69e5f69aa55589788fa2a945ad75adbeac172cc
- Tests: bun test test/memory-fence-e2e.test.ts test/cli/memory.test.ts test/mcp/memory.test.ts test/cli/global-options.test.ts test/spec/schemas/memory-schemas.test.ts test/spec/schemas/memory-contract.test.ts (72 pass, 0 fail, suite_rc=0), bun test (4628 pass, 2 skip, 0 fail, 180.3s, suite_rc=0; green receipt .flow/tmp/green-receipts/f69e5f69-unittest.json), bun run lint:check (rc 0; 1 pre-existing warning test/cli/query-text.test.ts:26), flowctl gate classify --base 027f64d36e63aced75be5db91c51c28be06140b9 -> FULL (src/cli/options.ts)
- PRs: