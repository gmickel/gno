---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13]
---
# fn-220-index-safety-config-opens-never-delete.1 Implement index safety, status, search speed, Capsule and eval fixes

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Implemented all of fn-220 (R1-R13) in one branch; five surfaces were built in parallel worktrees by subagents and integrated here.

- R1/R2: syncs and reads fail closed (STALE_COLLECTIONS) when the index holds indexed collections the config omits; nothing is deleted on open, refresh or automation. Only `gno collection remove`/`rename` (and MCP/REST/SDK forms) and `gno cleanup` delete; cleanup names its plan on stderr first and accepts `--json`. Status lists `staleCollections`. Long-running SDK, MCP and resident clients re-check per request (REST 409).
- R3/R4: `gno agents update` refreshes existing blocks only; skill install/uninstall/paths honor CLAUDE_CONFIG_DIR/CODEX_HOME.
- R5: status, doctor, MCP gno_status, SDK status, REST/Web UI name an unavailable collection root (`rootError`).
- R6/R7: no FTS5 snippet(); snippets from the matching chunk of returned rows only (long questions 1.8-10.9 s -> 0.21-0.32 s on a copy of the real index, ranking identical); Web UI Fast uses the hybrid fast path.
- R8: gno-context-agent-v2 projection with content date and supersededBy; memory facts dated by memory.createdAt (INGEST_VERSION 11).
- R9-R11: module-path helper, evalite reporter patch, worker start cause; ask.eval grounded mocks (77%, citations); agentic write lane checks embeddings via status.
- R13: MCP SDK 2.3.1, sharp 0.35.5, vitest 4.1.11.

stage: impl-review - ran (model: gpt-6.1-sol, high) NEEDS_WORK (3-reviewer panel) -> fix pass -> NEEDS_WORK (R2 open-client isolation) -> fix -> SHIP
Declined #4 (connector-verification MCP mode reading beyond its subset config): unchanged from before this change; reviewer withdrew it.
Not met exactly: R6 target <300 ms missed on 1 of 6 long questions (317 ms incl. ~100 ms CLI start); the rest is FTS prefix-term ranking, which needs an FTS prefix index migration (follow-up).

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 1875173e100d70d6c44baf83c78b86feb28b725e, d7a0440940528bc1fbd82efb6eff177d6861a44f, a7b1717230ff6444c5ff1c61c7f986ec8fb35a57
- Tests: bun test (6250 pass, 0 fail after fixes), bun run lint:check, bun run eval:memory (100%), skill eval 47/47
- PRs: