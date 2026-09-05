---
title: Frozen native baseline has incomplete repeated and expanded acceptance
date: "2026-09-05"
track: bug
category: runtime
module: src/llm/nodeLlamaCpp
tags: [qa, fn-143, fn-144, fn-145, cuda, metal]
problem_type: runtime
symptoms: Native aborts and expansion failures prevent complete paired acceptance
root_cause: Unresolved; captured native stacks do not identify the initiating caller
resolution_type: fix
related_to: []
---

## Problem
Severity P1, observed on frozen product commit 270c3a74 with isolated synthetic indexes and cached model hashes. CUDA warm30 produced 50/60 completed records; Metal embedding-only warm30 produced 57/60. Failed processes include native assertions and Bun segmentation faults. Reports remain incomplete and omit performance summaries.

## Reproduction and evidence
The committed fn-143 artifact README identifies commands, manifests, selected source archive and retained raw evidence. Native runs are serialized per physical GPU. Full raw records and watchdog logs remain under notes/fn143-native-tmp/qa-prep/; curated evidence is in .flow/artifacts/fn-143-paired-retrieval-quality-and-resource/.

CUDA expanded orchid requests returned truncated expansion JSON and expansion_error on both sides. Physical Ivan expanded/default-rerank attempts reached pressure level 2 and were stopped by the owned watchdog. Successful explicit no-rerank controls do not establish default-rerank coverage. Successful SDK expiry reacquisition does not repair the separately reproduced retained-port/API expiry failure.

## Limits and remaining work
A matched uninstrumented CUDA diagnostic completed 10 fresh processes and 20 queries. This narrows hypotheses but does not prove instrumentation caused the crashes. Native stack memory_breakdown frames alone do not establish the initiating caller. No original fixture, model, precision or quality threshold was changed.

Existing fn-144 and fn-145 own the recovery and capacity work; no additional spec is created. Native promotion requires the successor candidate to satisfy the preserved original gates, including physical Ivan expanded queries. Superseded fn-138 and fn-141 remain untouched.
