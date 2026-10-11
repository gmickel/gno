---
satisfies: [R1, R2, R3]
---
# fn-217-correctness-fixes-missing-collection.1 Implement Correctness fixes: missing collection roots and unknown MCP arguments

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
A collection root that cannot be resolved (or listed) no longer empties the collection. Full syncs (walker `any` mode) treat it as an unproven prefix; path syncs (watcher, targeted) check per absent file that the root can be listed and otherwise return a SOURCE_AVAILABILITY_UNKNOWN path error plus one collection-level error (recorded for status). The terminal summary prints collection-level errors without --verbose; the daemon's sync log line carries them. An existing empty root keeps deletion semantics; cleanup during an outage keeps content (documents stay active).

MCP inputs are closed: the registrar applies .strict() to every object input schema and the two union inputs' members are strict, so an undeclared key fails validation naming the key and the handler never runs. Golden regenerated; the frozen SDK comparison drops `additionalProperties: false` on both sides.

Live repro (sandbox, branch build): root renamed away -> `gno update` prints `[SOURCE_AVAILABILITY_UNKNOWN] Collection root could not be resolved (ENOENT ... lstat '<path>')`, search keeps 3 hits; root back -> normal.

stage: impl-review - ran (model: gpt-6.1-sol, high) NEEDS_WORK (mid-batch outage reused a root check; resolvable-but-unlistable root; warning missing from errors/watcher) -> fixed -> SHIP

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 7c9f05c55e0fe0cd4ebddef005f28e305a9a4ac4, 8cb8b5742fc4f4a83cf7cd209a14005c0a7831f5, 49097d55bd6cd34b4bbe68eda43cac62ce6974ff, f1dd54a7e57f28048f00a177310ba247db380f50, bb89119e263c54577d8cadd9fec5491d4a68b15a
- Tests: bun test (6189 pass, 0 fail), bun test test/ingestion test/serve test/cli/daemon* test/mcp (1764 pass), bun run lint:check, bun scripts/docs-verify.ts, bun run eval:sessions (100%)
- PRs: