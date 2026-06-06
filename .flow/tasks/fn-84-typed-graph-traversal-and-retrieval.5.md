---
satisfies: [R7, R8]
---

## Description

Expose graph traversal and retrieval diagnostics over REST: `POST /api/graph/query` and `POST /api/query/diagnose`, **wrapping the shared core services** from tasks .3/.4 (NOT CLI internals, no duplicated logic). Backward compatible — existing `GET /api/graph`, link/query routes unchanged. Disjoint files from MCP task (.6) — parallelizable.

**Size:** M
**Files:** `src/serve/server.ts`, `src/serve/routes/graph.ts`, `src/serve/routes/api.ts`, `docs/API.md`, `test/serve/*.test.ts`, `test/spec/schemas/*.test.ts`

## Approach

- Register `POST /api/graph/query` + `POST /api/query/diagnose` in the `Bun.serve({ routes: {...} })` object (`server.ts:177-656`, NOT a router file). Wrap in `withSecurityHeaders(...)`; apply the CSRF/Origin check (`api.ts:4118`).
- Handlers call the **shared bounded-traversal fn (.3)** and **`diagnoseQueryTarget()` (.4)** directly — mirror the `handleGraph` shape (`routes/graph.ts:95`: parse → call core → `jsonResponse`/`errorResponse`). Ports come from `ServerContext` (`context.ts:65,92`); do not instantiate adapters here.
- Validate responses against `graph-query.schema.json`/`query-diagnose.schema.json` (.3/.4). REST contract tests.

## Investigation targets

**Required:**

- `src/serve/server.ts:177-656` — `routes:` object; `/api/graph` GET `:650`, `/api/query` POST `:481`
- `src/serve/routes/graph.ts:30-95` — `handleGraph` shape to mirror
- `src/serve/routes/api.ts:3352,4118` — `handleQuery`, CSRF/Origin check
- `src/serve/context.ts:65,92-173` — `ServerContext` ports

## Acceptance

- [ ] `POST /api/graph/query` wraps the shared traversal core; response matches `graph-query.schema.json`
- [ ] `POST /api/query/diagnose` wraps `diagnoseQueryTarget()`; response matches `query-diagnose.schema.json` (BM25-only safe)
- [ ] Both routes use `withSecurityHeaders` + CSRF/Origin; ports from `ServerContext`; no logic duplicated from CLI
- [ ] Existing `GET /api/graph` + link/query routes unchanged (backward compat tested)
- [ ] `docs/API.md` documents both endpoints (request/response + curl)
- [ ] REST contract/integration tests pass

## Done summary

_Filled in on completion._

## Evidence

_Links to commits, tests, and verification._
