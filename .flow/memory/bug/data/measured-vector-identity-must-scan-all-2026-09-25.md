---
title: Measured vector identity must scan all partitions of a vector space
date: "2026-09-25"
track: bug
category: data
module: src/store/vector/runtime-compat.ts
tags: [fn-184, vector-partitions, runtime-identity]
problem_type: data
symptoms: Bun upgrade after fork re-forked; context change forked silently; stale vectors reused
root_cause: Resolution derived candidate partitions from the current runtime instead of stored vector-space membership
resolution_type: fix
---

## Problem
The first fn-184 cut keyed "confirmed" separate vector partitions by the exact runtime fingerprint and only compared a new runtime against the primary partition. A Bun upgrade after a fork demanded another full fork, a changed context size built a new partition without the R3 confirmation gate, and a runtime adopting an "unverified" partition could later rebind stale vectors produced by a different runtime.

## What Didn't Work
Checking only `primary` plus `fork(runtime)` by exact id; treating "no samplable owner" as "empty"; picking status's partition by the last embedding selection (runtime-specific) while queries resolve per runtime.

## Solution
`src/store/vector/runtime-compat.ts` resolveRuntimePartition measures every non-legacy partition sharing `base_fingerprint` (primary first, then forks by coverage) and reuses the first compatible one; a missing primary for a model that already has partitions is blocked. `src/embed/backlog.ts` runs `collectGarbage()` before recording a reference runtime. Status tiers prefer the activated primary and expose `compatibleRuntimes`. Migration ranks legacy candidates by current coverage only.

## Prevention
When identity moves from a key to a measured check, enumerate every stored partition of the same vector space, not the ones derivable from the current runtime; distinguish "empty" from "unmeasurable"; make status selection runtime-independent or report per-runtime readers.
