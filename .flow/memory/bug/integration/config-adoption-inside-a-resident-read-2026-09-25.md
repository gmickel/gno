---
title: Config adoption inside a resident read voids its own response (409)
date: "2026-09-25"
track: bug
category: integration
module: src/serve/routes/sessions.ts
tags: [fn-185, resident, egress-epoch, sessions]
problem_type: integration
symptoms: First /api/sessions/status after a CLI source add into a new collection answers 409 EGRESS_POLICY_CHANGED
root_cause: adoptConfig rotates the authorization epoch while handleResidentRead holds the pre-adoption epoch
resolution_type: fix
related_to: [bug/integration/write-lease-gate-missed-embed-2026-09-25]
---

## Problem
A resident `gno serve` read route (`/api/sessions/status`) was made to adopt the on-disk config when the CLI changed it. The adoption ran inside `handleResidentRead`, and adopting a config with a new collection calls `invalidateEgressPolicy`, which moves the resident authorization epoch. The wrapper then saw the admitted epoch as stale and replaced the successful response with `409 EGRESS_POLICY_CHANGED`. Handler-level tests passed because they bypass the wrapper.

## What Didn't Work
Refreshing config at the top of the handler passed to `handleResidentRead`.

## Solution
Refresh (and adopt) before admission: `refreshSessionsConfig(ctxHolder, store)` runs in the route in `src/serve/server.ts` ahead of `handleResidentRead`, and the read itself stays side-effect free. The adopted config is binding-checked (`assertInstanceBinding(ctxHolder, loaded)`) before `adoptConfig` syncs collections, so a config rebound to another index cannot delete collections first.

## Prevention
Any state change that can rotate the authorization epoch (collection membership, egress policy) never runs inside a resident read. Test such routes through `startServer` with a runtime whose `admitRequest` tracks an epoch that `invalidateEgressPolicy` bumps (see test/serve/sessions-api.test.ts "adopts a CLI-added collection without voiding the read").
