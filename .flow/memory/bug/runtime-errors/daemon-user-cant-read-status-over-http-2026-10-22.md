---
title: Daemon user can't read status over HTTP with 65+ collections — 403 COLLECTION_LI
date: "2026-10-22"
track: bug
category: runtime-errors
module: src/cli/commands/daemon.ts authorizeDaemonStatus
tags: [qa, fn-226, egress]
problem_type: runtime-error
symptoms: GET /api/resident/status on gno daemon returns 403 COLLECTION_LIMIT_EXCEEDED from loopback with 65+ collections
root_cause: (observed via live QA — unconfirmed)
resolution_type: fix
related_to: [bug/runtime-errors/doc-view-logs-a-503-console-error-on-2026-09-02, bug/runtime-errors/reader-sees-document-event-stream-fail-2026-09-05]
---

## Problem
A user running `gno daemon` with more than 64 collections cannot read its status over HTTP, even from loopback: the status route is denied by the collection limit.

## Steps to reproduce (cold)
1. Sealed sandbox with 65 configured collections; `gno daemon --port 3481`.
2. `curl -s http://127.0.0.1:3481/api/resident/status`
3. Observe the HTTP status and body.

## Expected
Status is content-free metadata; `docs/CONFIGURATION.md` (new "Collection limits") only promises that an unscoped request over the bound is denied, which is what happens, but nothing tells a daemon user how to read status with 65+ collections.

## Actual
HTTP 403 `{"error":"EGRESS_DENIED",...,"reason":"COLLECTION_LIMIT_EXCEEDED"}` at 65 and (on the branch) 129 configured collections. `authorizeDaemonStatus` evaluates `serve` egress over every configured collection with no way to scope it. Same 403 on main at 65; at 129 main returned 500. Pre-existing behaviour that fn-226 keeps by design (R2); filed so a later spec can decide whether status should be exempt or scoped.

## Evidence
- console: .flow/tmp/qa-fn-226-egress-collection-limits-deny-cleanly/surfaces-main.log, surfaces-branch.log ("daemon status")
- url: http://127.0.0.1:3481/api/resident/status

## Traceability
- R-IDs: [R3] (denial shape correct; usability gap)   scenario: S5   driver_rung: HTTP curl   viewport: n/a
