# fn-74-upstream-freshness-and-code-retrieval.5 Improve MCP ergonomics and agent guidance

## Description

Improve GNO's MCP ergonomics without adding new core capability. The goal is to make agents use the existing search/query/get/multi-get/status tools more effectively and with fewer wasted calls.

Focus areas:

- tool descriptions that nudge good search strategy
- clearer use of `intent`, `queryModes`, `thorough`, `rerank`, and `candidateLimit`
- search-then-get and search-then-multi-get workflows
- line-range retrieval after search results include `line`
- indexed URI handling and mixed-index safety
- actionable failures for model/vector/index state

Compare against QMD's concise MCP guidance, but implement in GNO's vocabulary and public docs. Do not mention QMD publicly.

## Acceptance

- [ ] Review current MCP tool schemas/descriptions in `src/mcp/tools/index.ts`, `spec/mcp.md`, and `docs/MCP.md`.
- [ ] Improve read/search tool descriptions so agents choose between `gno_search`, `gno_vsearch`, `gno_query`, `gno_get`, and `gno_multi_get` correctly.
- [ ] Explicitly document/nudge use of `intent` for ambiguous terms and `queryModes` for structured term/intent/hyde retrieval.
- [ ] Document/nudge line-range retrieval from search result `line`, including using `fromLine`/`lineCount` to avoid over-fetching.
- [ ] Document/nudge `multi-get` for batching top results after search, including max bytes/line numbers.
- [ ] Preserve existing schemas except additive descriptions or optional metadata; any output/input change updates `spec/mcp.md`, docs, schemas, SDK/tests as needed.
- [ ] Add/update MCP tests where descriptions/schema behavior are asserted or smokeable.
- [ ] Update `assets/skill/SKILL.md` and related skill examples if agent workflow guidance changes.
- [ ] Run targeted MCP tests plus full gate as appropriate.

## Done summary

Improved MCP tool descriptions and retrieval guidance without schema changes, added assertions for description nudges, updated MCP docs/spec/skill, and verified autoresearch skill eval remains 100%.

## Evidence

- Commits:
- Tests:
- PRs:
