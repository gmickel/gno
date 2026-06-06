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

- [ ] Link resolver/projection helper extracted from `getGraph()`; `getGraph()` refactored to call it; existing graph tests pass unchanged (no behavior change)
- [ ] `parseRef`/`resolveDocRef` moved to `src/core/ref-parser.ts`; CLI re-exports; existing ref-parser + CLI tests pass unchanged
- [ ] No public API/output behavior change (pure refactor verified by existing suites)

## Done summary

_Filled in on completion._

## Evidence

_Links to commits, tests, and verification._
