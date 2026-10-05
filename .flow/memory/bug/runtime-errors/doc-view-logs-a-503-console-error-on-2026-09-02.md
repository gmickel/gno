---
title: Doc View logs a 503 console error on every open without vectors
date: "2026-09-02"
track: bug
category: runtime-errors
module: src/serve/routes/api.ts
tags: [qa, fn-136-pdf-viewing-over-a-remote-link, web-ui]
problem_type: runtime-error
symptoms: /api/doc/:id/similar returns 503 on an index without embeddings; one console error per document open
root_cause: (observed via live QA — unconfirmed)
resolution_type: fix
last_audited: "2026-10-05"
---

## Problem
Every Doc View open logs a console error: `/api/doc/:id/similar` answers 503 on an index without vectors, so a real user sees a red network error in devtools on each document.

## Steps to reproduce (cold)
1. Start `gno serve` on an index with no embeddings and open `/doc?uri=gno://notes/sample.pdf`.
2. Open the browser console.
3. Observe `Failed to load resource: the server responded with a status of 503 (Service Unavailable)` for the similar-documents request.

## Expected
A document view on an index without vectors should not emit a failing request on every open; the similar-documents panel should degrade quietly (a 200 with an empty or "unavailable" payload, or no request when the capability is absent).

## Actual
One 503 response and one console error per document open, on every scenario of this pass (S1, S2, S4, S7, S11 among others).

## Evidence
- console: .flow/tmp/qa-fn-136-pdf-viewing-over-a-remote-link/S1-whole-file-tier-console.log
- network: .flow/tmp/qa-fn-136-pdf-viewing-over-a-remote-link/S1-whole-file-tier-network.json (the 503 entry on the similar endpoint)
- url: http://127.0.0.1:3917/doc?uri=gno%3A%2F%2Fnotes%2Fmedium.pdf

## Traceability
- R-IDs: [] (not a fn-136 requirement; observed while driving R1/R3/R4 scenarios)   scenario: S1   driver_rung: playwright   viewport: 1280x800
- Classification: pre_existing (task .5 of fn-136 had already noted it as a follow-up)
