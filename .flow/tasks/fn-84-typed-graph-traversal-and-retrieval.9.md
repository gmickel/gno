---
satisfies: [R8]
---

## Description

Two **behavior-preserving** extractions that unblock the typed-graph work, kept separate so they can land + be verified independently against existing test suites before the riskier schema/projection work (task .1). No behavior change.

**Size:** S/M
**Files:** `src/store/sqlite/adapter.ts`, `src/core/graph-resolver.ts` (new), `src/core/ref-parser.ts` (new), `src/cli/commands/ref-parser.ts`, `test/store/*.test.ts`, `test/cli/*.test.ts`

## Approach

- **Extract the link resolver from `getGraph()`:** the `wikiBestMatch`/path/title resolver + projection logic is embedded as local SQL helpers inside `getGraph()` (`adapter.ts:2301`). Lift it into a shared, behavior-preserving helper (e.g. `src/core/graph-resolver.ts` or a store method) and refactor `getGraph()` to call it. Existing graph tests must pass unchanged — this is a pure refactor that later lets backfill (task .1) reuse the exact resolver for `getGraph` parity.
- **Extract pure ref parsing to `src/core/`:** move `parseRef`/`resolveDocRef` from `src/cli/commands/ref-parser.ts` to `src/core/ref-parser.ts` (or `doc-ref.ts`); the CLI module re-exports so existing imports keep working. Lets REST/MCP cores (.3/.4/.5/.6) resolve refs without importing from `src/cli/commands/`.

## Investigation targets

**Required:**

- `src/store/sqlite/adapter.ts:2301` — `getGraph()` resolver/projection helpers to lift
- `src/cli/commands/ref-parser.ts` — `parseRef`/`resolveDocRef` to relocate
- `src/core/links.ts` — existing core link utilities (where resolver naturally belongs)

**Optional:**

- `test/store/*graph*.test.ts`, `test/cli/*ref*.test.ts` — suites that must stay green

## Acceptance

- [x] Link resolver/projection helper extracted from `getGraph()`; `getGraph()` refactored to call it; existing graph tests pass unchanged (no behavior change)
- [x] `parseRef`/`resolveDocRef` moved to `src/core/ref-parser.ts`; CLI re-exports; existing ref-parser + CLI tests pass unchanged
- [x] No public API/output behavior change (pure refactor verified by existing suites)

## Done summary

Behavior-preserving extraction completed.

- Moved document ref parsing/resolution to `src/core/ref-parser.ts`; CLI parser now re-exports for compatibility.
- Extracted getGraph wiki resolver SQL helpers to `src/core/graph-resolver.ts`; `getGraph()` now calls the shared helper names.
- Updated SDK/MCP/publish imports to use core ref parsing instead of CLI internals.

No public output/API behavior change intended.

## Evidence

- Commits:
- Tests: bun test test/store/links.test.ts test/mcp/links-integration.test.ts test/cli/commands/links.test.ts test/cli/get.test.ts test/sdk/client.test.ts test/mcp/tools/links.test.ts, bun test test/cli test/mcp test/sdk, bun run lint:check
- Review: RepoPrompt implementation review SHIP, no findings (`/tmp/fn84-9-rp-review.md`)
- PRs:
