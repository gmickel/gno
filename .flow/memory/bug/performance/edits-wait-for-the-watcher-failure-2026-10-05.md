---
title: Edits wait for the watcher failure backoff while another file keeps failing
date: "2026-10-05"
track: bug
category: performance
module: src/serve/watch-service-events.ts
tags: [qa, fn-202-watcher-retries-a-failing-collection, watcher]
problem_type: performance
symptoms: A healthy edit is indexed 12-14 s late after 20 s of failures elsewhere in the collection; up to 5 min at the cap
root_cause: (observed via live QA — unconfirmed)
resolution_type: fix
---

## Problem
A user editing a healthy note waits for the watcher's failure backoff when another file in the same collection keeps failing to sync. Observed on the live resident at fn-202 head 6b68fd35.

## Steps to reproduce (cold)
1. Start an isolated resident: `GNO_CONFIG_DIR=<cfg> GNO_DATA_DIR=<data> bun src/index.ts serve --host 127.0.0.1 --port 3988` with a collection `corpus` of Markdown notes, fully indexed.
2. Create `corpus/dir7/qa-bad-1.md`, then `chmod 000` it and `touch` it, so every watcher sync of that path fails with EACCES.
3. Wait 20 s (the watcher retries the failing path with growing delays).
4. Append `healthy edit qa-healthy-marker-1-a` to `corpus/dir9/note-9.md`.
5. Poll `POST http://127.0.0.1:3988/api/search` with `{"query":"qa-healthy-marker-1-a","limit":1}` once a second.

## Expected
R1: "Pending work stays durably queued, as it does today." Before this change a fresh edit in the collection was flushed after the 300 ms debounce (2 s ceiling); only the failing path should wait.

## Actual
The healthy edit is found 13.7 s (run 1) and 12.0 s (run 2) after the write. `scheduleFlush` returns early while a retry timer is armed, so the fresh event waits for the backoff timer. The wait grows with how long the other file has been failing, up to the 5 minute cap.

## Evidence
- console: .flow/tmp/qa-fn-202-watcher-retries-a-failing-collection/F1-healthy-edit-delayed.log
- related: .flow/tmp/qa-fn-202-watcher-retries-a-failing-collection/S2-reset-after-success.log (fixed file not picked up within 6 s)
- url: http://127.0.0.1:3988/api/search

## Traceability
- R-IDs: [R1]   scenario: S4   driver_rung: CLI/REST   viewport: n/a
