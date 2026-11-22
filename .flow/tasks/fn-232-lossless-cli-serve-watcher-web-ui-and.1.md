---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-232-lossless-cli-serve-watcher-web-ui-and.1 Implement Lossless CLI, serve, watcher, Web UI, and MCP performance

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Implemented all lossless CLI, serve, watcher, Web UI, and MCP optimizations (R1–R6) and resolved all 16 Round-1 and 4 Round-2 Codex implementation-review findings (`codex:gpt-6.2-sol:medium`, final verdict: `SHIP`, 0 introduced / 0 pre-existing findings).

Measured improvements:
- CLI `gno --version` cold start: 43.9 ms -> 14.6 ms (3.0x faster); zero eager imports of `@modelcontextprotocol/client` or `findings-run-state` in `status`/`serve`; standalone `franc` bundling verified.
- Production SPA snapshot (`assets/spa-production.json.gz`): 2.55 MiB (438 files) -> 2.14 MiB (403 files, -427 KB gzipped); first-load JS entry 655.6 KB -> 545.0 KB (-16.9%); read-only `DocView` chunk 67.4 KB with zero CodeMirror or `mdast` dependencies.
- Resident runtime: bracketed startup config stamp + post-watcher reconciliation, `fs.watch` + 60s fallback replacing 2s idle polling, in-process production SPA serving with cached gzip hit before fetch and `304 Not Modified` HTML ETag.
- REST & SQLite: `json_each(?)` similarity lookup, 5-column Unicode-safe SQL autocomplete pre-filter preserving JS `localeCompare` + `slice(0, limit)`, single-pass `buildBrowseTree` with O(1) indexed `findBrowseNode`, single-manifest `buildAppStatus`, transaction-safe `data_version` caches, REST JSON gzip (> 2 KiB + `Vary: Accept-Encoding`).
- Watcher & SSE: O(total_dirs) outer-map snapshot copy, constructor-allocated watch hosts + cached `WalkConfig`, bounded-concurrency (32) presence checks preserving deterministic order, zero-subscriber SSE short-circuit.
- MCP server: WeakMap strict schema cache + precomputed static tool tables, HTTP-scoped async RW lock (including read-only `gno_context`) with serial stdio preserved, cancellation-isolated warm port caching and egress-safe lazy vector index, no `request.clone()`, bounded `deriveRequestIdentity` cache.

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: de71436f, bd63be36, f5987ee2
- Tests: bun run typecheck, bun run lint:check, bun run test:tmp-check (6526 pass, 3 skip, 0 fail), bun run test:web (411 pass, 0 fail), bun run test:e2e (Web UI smoke passed), bun test test/serve/fn232-runtime-surface-performance.test.ts test/serve/public/fn232-webui-performance.dom.test.tsx, flowctl codex impl-review --spec codex:gpt-6.2-sol:medium (VERDICT=SHIP)
- PRs: