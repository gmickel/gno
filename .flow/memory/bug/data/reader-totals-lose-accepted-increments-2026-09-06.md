---
title: Reader totals lose accepted increments after connection checkout timeout
date: "2026-09-06"
track: bug
category: data
module: reader-views
tags: [qa, fn-156, reader-views, resolved]
problem_type: data
symptoms: Accepted aggregate deltas fail to recover after a pre-SQL connection timeout
root_cause: Pool acquisition failure was classified as an ambiguous commit outcome before SQL submission
resolution_type: fix
---

## Problem
Under concurrent reader traffic, aggregate views already accepted into the buffer disappeared after database connection checkout timed out before any SQL was submitted. This violated the definite-failure retry requirement. Reading remained available. The finding is resolved.

## Steps to reproduce
1. Start the pre-fix hosted build 904553c with the pinned synthetic PostgreSQL fixture and Bun 1.4.2.
2. Run the preserved diagnostic-64k-20260906-1503 workload: secret-link 64 KB, concurrency eight, three repeats, with actual view and count requests.
3. Observe the private diagnostic wrapper's aggregate-write checkout phase. It records timing, pool occupancy, and whether Client.query was called; it omits SQL and credentials.
4. After traffic drains, wait another six seconds and compare accepted view responses with the persisted counter delta.

## Expected
"On a definite database failure, requeue within the memory bound. On an ambiguous commit outcome, discard the uncertain batch rather than blindly retrying and double counting."

## Actual
Repeats one and three timed out before Client.query dispatch. The writer classified those definite failures as uncertain, so counts did not recover after the queues emptied.

## Evidence
- Failure phase: .flow/tmp/qa-fn-156-reader-reading-time-total-views-and/r4-failure.json
- Accepted versus persisted counts: .flow/tmp/qa-fn-156-reader-reading-time-total-views-and/r4-failed-counts.json
- Fixed recovery: .flow/tmp/qa-fn-156-reader-reading-time-total-views-and/r4-recovery.json
- Route: POST http://127.0.0.1:3346/api/reader-views, synthetic publication only.
- Original workload, raw logs and SHA-256 manifests remain in the private paired/runs evidence directory.

## Resolution
Commit 68a95a9 explicitly acquires the analytics connection before submitting SQL. Checkout failure now raises DefiniteViewWriteFailure and uses bounded requeue; an uncertain outcome after submission still discards the detached batch. The client is released once.

The live corrected writer recovered all 97, 91, and 94 accepted increments in three repeats. The first repeat reproduced a pre-dispatch checkout timeout and then persisted all accepted increments. Nine writer regressions cover checkout failure, successful bounded recovery, SQLSTATE classification, unknown outcomes, and client cleanup. Subsequent final-build sustained runs also persisted every accepted increment. Rejected analytics signals remain a documented approximation under load.

## Traceability
- fn-156, R4; introduced edge-case defect, resolved before release.
- Driver: actual HTTP requests, PostgreSQL counters, private runtime phase observation.
