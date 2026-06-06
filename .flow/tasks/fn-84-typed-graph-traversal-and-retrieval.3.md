---
satisfies: [R4, R7, R8]
---

## Description

Build the **shared bounded-traversal core** (recursive CTE over `doc_edges` from a resolved root) and expose it via the `gno graph query <doc>` CLI command. The core is a non-CLI entry point that REST (.5) and MCP (.6) also wrap — no CLI-internal coupling. (Links/backlinks typed filters split into task .8.)

**Size:** M
**Files:** `src/store/sqlite/adapter.ts` (or new `src/core/graph-query.ts`), `src/store/types.ts`, `src/cli/commands/graph.ts`, `src/cli/program.ts`, `src/cli/options.ts`, `spec/cli.md`, `spec/output-schemas/graph-query.schema.json`, `docs/CLI.md`, `test/store/*.test.ts`, `test/cli/*.test.ts`, `test/spec/schemas/validator.ts`, `test/spec/schemas/*.test.ts`

## Approach

- **Shared core (the deliverable REST/MCP consume):** a bounded traversal function over `doc_edges` SQL — **recursive CTE BFS from a single resolved root** (resolve via the **core ref module `src/core/ref-parser.ts`** extracted in task .9, NOT `src/cli/commands/ref-parser.ts`, and NOT the global capped `getGraph` export at `adapter.ts:2301` which is wrong/unsafe for per-root traversal of isolated roots). Direction via separate inbound/outbound `UNION` arms; cycle safety via `UNION` + delimiter-wrapped `instr` (not `LIKE`); deterministic `ORDER BY (depth, edge_type, dst)` before any `LIMIT`. Reads use the `(src,dst,edge_type)` dedup from task .1.
- **Bounded frontier mechanics (hub-node safety) — not just final caps:** a final `ORDER BY ... LIMIT` can still enumerate a huge frontier before truncation on a hub node. Enforce a **hard depth clamp**, a **per-depth frontier cap**, and a **SQL-level visited-row cap inside the recursion** (e.g. bound the recursive set / `LIMIT` within the CTE), so intermediate work stays bounded. Emit `truncated` when any cap trips. Prove with a hub-graph runtime test, not only assertions on final node/edge counts.
- `gno graph query` registered in `wireGraphCommand` (`program.ts:2280`) — wraps the core. Add command id + format matrix entry in `src/cli/options.ts:21` `CMD`.
- New `graph-query.schema.json` (nodes/edges with `edgeType`/`relationType`/`confidence`/`edgeSource`, depth, `truncated`; **per-node `graphHints` field** from the node's content type so non-primary hints are surfaced, not just prose) — **`schemaVersion` required** (new schema). **Register the schema name in `test/spec/schemas/validator.ts`** (it hardcodes a `schemaFiles` array — new schemas won't load otherwise). Contract test mirroring `test/spec/schemas/api-graph.test.ts`.
- CLI pattern: `getFormat` → `assertFormatSupported(CMD.graphQuery, format)` → dynamic import → `CliError` → `writeOutput`.
- **Shared-file note:** `program.ts`/`options.ts`/`spec/cli.md`/`docs/CLI.md` graph sections also touched by task .8 (links/backlinks); `.8` is serialized after this task.

## Acceptance

- [ ] Shared bounded-traversal core exists as a **non-CLI entry point** (store/core fn) consumed by CLI/REST/MCP; root resolved via the core `src/core/ref-parser.ts` module
- [ ] Recursive-CTE traversal: direction `out|in|both`, edge-type filter, cycle-safe, deterministic ordering
- [ ] Bounded frontier: hard depth clamp + per-depth frontier cap + in-recursion visited-row cap; `truncated` flag; **hub-graph runtime test proves intermediate work stays bounded**
- [ ] `gno graph query <doc>` wraps the core; registered in `options.ts` `CMD` + format matrix
- [ ] `graph-query.schema.json` added with required `schemaVersion`; registered in `validator.ts` `schemaFiles`; contract test passes
- [ ] `spec/cli.md` + `docs/CLI.md` graph sections updated
- [ ] Regression tests cover traversal limits, isolated-root, edge-type filtering, direction, determinism, and the `truncated` path

## Done summary
Implemented shared bounded typed-edge traversal and `gno graph query <doc>`.

- Added non-CLI `diagnoseGraphQuery` core using core ref parsing and active-root validation.
- Added SQL bounded traversal over `doc_edges` with direction, edge-type filtering, cycle safety, hard depth clamp, frontier cap, visited cap, truncation warnings, and covering traversal indexes.
- Added CLI wiring, output schema, schema contract registration, CLI/docs/spec updates.
- Added regression coverage for hub caps, inactive/stale edges, max-depth boundary probes, cycle eligibility before candidate limits, unique next-node frontier ranking, silent global-depth frontier truncation, and edge-type fanout bounding.
- RepoPrompt implementation review returned SHIP.
## Evidence
- Commits:
- Tests: bun run lint, bun run lint:check, bun test test/core/graph-query.test.ts test/spec/schemas/graph-query.test.ts test/cli/commands/links.test.ts test/store/links.test.ts test/store/adapter.test.ts test/store/migrations.test.ts (107 pass), bun test test/core test/store test/spec/schemas test/cli/commands/links.test.ts (468 pass)
- PRs: