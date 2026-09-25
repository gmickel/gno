---
title: Write-lease gate missed embed preparation writes before the page loop
date: "2026-09-25"
track: bug
category: integration
module: src/embed/backlog.ts
tags: [write-lease, embed, resident, fn-180]
problem_type: integration
symptoms: "Resident preparation writes (variant partition, selection) ran outside the lease"
root_cause: Gate wrapped page loop only; prepareEmbeddingBacklog writes first
resolution_type: fix
---

## Problem
Gating the resident's background embed writes under the shared writer lease covered each backlog page and the final activation, but `embedBacklog()` first runs `prepareEmbeddingBacklog()`, which for native ports creates the vector variant store (`BEGIN IMMEDIATE`, partition rows) and writes the partition selection. Those writes ran outside the lease, so CLI contention turned into failed passes that the new retry cap would park.

## What Didn't Work
Wrapping only the loop bodies in `variant-backlog.ts` / `backlog.ts`; the unit test injected a pre-built `variantStore`, which skipped the preparation path entirely.

## Solution
`src/embed/backlog.ts` `embedBacklog`: when a write gate is present, call `embedPort.init()` first (model load stays outside the lease), then run `prepareEmbeddingBacklog` inside `inWriteTurn` and return `deferred` when the lease is held. Test through production preparation (a port with `getIdentity` and no `variantStore`).

## Prevention
When gating writes, grep the whole call path from the gate owner down for every write, including setup/prepare helpers; exercise the production setup path in the test, not a pre-built fixture.
