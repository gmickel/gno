# Status endpoint stalls while the resident is busy

## Problem

`/api/resident/status` answers in about 1 ms when the resident is idle but stalls for hundreds of milliseconds to seconds under load. The handler only reads in-memory state, so this is main-thread blocking: synchronous SQLite work or long synchronous loops in the resident starve the event loop. The battery-drain reporter saw status requests time out at 8 s for the same reason.

fn-203 soak harness measurements (probe every 2 s; provisional limit p99 250 ms):

| Scenario | p99 | max |
| --- | --- | --- |
| smoke churn (edits, readers, MCP, CLI writers) | 465 ms | 695 ms |
| embedder failing (500s, malformed, hang, down) | 292 ms | 1.3 s |
| config rewritten every 15 s under churn | 1.1 s | 1.1 s |
| 300 event-stream subscribers + churn | 1.7 s | 1.7 s |
| after waking from 90 s SIGSTOP (laptop sleep) | 4.8 s | 5.8 s |

Repro: `bun run soak --tier torture --classes sleep-wake,sse-flood,config-edit --contain`.

## Acceptance Criteria

- **R1:** Profile the resident in each scenario above (`bun --cpu-prof`) and name the synchronous work that holds the event loop.
- **R2:** Bound that work: yield between batches, move it off the main thread, or split long transactions, so status p99 stays within the I4 limit in all five scenarios.
- **R3:** Set the I4 limit in `scripts/soak/config.ts` from a measured healthy baseline (the open fn-203 decision) and record it.
