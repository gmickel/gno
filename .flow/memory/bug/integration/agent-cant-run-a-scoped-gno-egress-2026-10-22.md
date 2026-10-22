---
title: Agent can't run a scoped gno_egress_check over HTTP MCP with 65+ collections — 4
date: "2026-10-22"
track: bug
category: integration
module: src/mcp/http-egress.ts requestedCollections
tags: [qa, fn-226, egress]
problem_type: integration
symptoms: "gno_egress_check with collections [c3] denied 403 when more than 64 collections are configured"
root_cause: (observed via live QA — unconfirmed)
resolution_type: fix
related_to: [bug/integration/cli-user-cant-check-egress-for-all-2026-10-22, bug/integration/reader-opens-a-relative-markdown-note-2026-09-05]
---

## Problem
An agent calling `gno_egress_check` over the resident HTTP MCP endpoint with an explicit `collections` scope is denied whenever more than 64 collections are configured, even for one collection.

## Steps to reproduce (cold)
1. Sealed sandbox with 65 configured collections, all `egressPolicy: remote`; `gno serve --port 3491`.
2. POST http://127.0.0.1:3491/mcp initialize, then `tools/call` `gno_egress_check` with `{"action":"export","destinationZone":"remote","caller":{"authenticated":true,"operationAuthorized":true},"contentClass":"source","collections":["c3"]}`.
3. Observe the HTTP status and body.

## Expected
The transport's egress check covers "the collections it names" (spec/mcp.md), so a check scoped to `c3` should be evaluated and return the decision for `c3` (stdio MCP returns `mode=complete`).

## Actual
HTTP 403, `-32003 Operation blocked by collection egress policy`, reason `COLLECTION_LIMIT_EXCEEDED`. The HTTP gate (`src/mcp/http-egress.ts` `requestedCollections`) reads `collections` only for `COLLECTIONS_SCOPE_TOOLS`, which does not list `gno_egress_check`, so the call is treated as unscoped. Same on main (5eaad246) at 65 configured; at 129 main returned 500, the branch now 403. Pre-existing.

## Evidence
- console: .flow/tmp/qa-fn-226-egress-collection-limits-deny-cleanly/egress-check-main.log, egress-check-branch.log, egress-check-stdio-branch.log
- url: http://127.0.0.1:3491/mcp

## Traceability
- R-IDs: [] (regression; outside fn-226 scope, R2 keeps 1 to 128 unchanged)   scenario: S7   driver_rung: HTTP fetch   viewport: n/a
