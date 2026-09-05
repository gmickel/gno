---
title: Reader sees document event stream fail while the document is idle
date: "2026-09-05"
track: bug
category: runtime-errors
module: src/serve/doc-events.ts
tags: [qa, fn-154, document-events]
problem_type: runtime-error
symptoms: Idle /api/events stream emits net::ERR_INCOMPLETE_CHUNKED_ENCODING on baseline and candidate
root_cause: (observed via live QA - unconfirmed)
resolution_type: fix
related_to: [bug/runtime-errors/doc-view-logs-a-503-console-error-on-2026-09-02]
---

## Problem
A reader leaves a document open and its event stream disconnects with a browser console error. The rendered document remains usable. The captured result proves connection errors; it does not prove lost updates or data loss.

## Steps to reproduce (cold)
1. Start an isolated GNO server with synthetic indexed Markdown note gno://notes/smoke-note.md; no embeddings are required.
2. Open http://127.0.0.1:43553/doc?uri=gno%3A%2F%2Fnotes%2Fsmoke-note.md at 375x812, adjusting the port to the isolated server. Wait for document text to render.
3. Record console and failed requests. Keep the document page open without navigation for 18 seconds.
4. Inspect the /api/events request and console, then repeat on the independent baseline package at port43875.

## Expected
A subscribed idle document event stream stays connected through its keepalive cycle, or closes gracefully without a malformed/incomplete response error.

## Actual
Both runs record /api/events request failure "net::ERR_INCOMPLETE_CHUNKED_ENCODING" and console "Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING" during the idle wait. This differs from expected net::ERR_ABORTED events caused by deliberate navigation, which the evidence also retains.

## Evidence
- Candidate console/network: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-observed-idle/web-events.json.gz.
- Baseline console/network: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-baseline-idle/web-events.json.gz.
- Idle document screenshots: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-observed-idle/document-idle.png.gz and .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-baseline-idle/document-idle.png.gz.
- Failure URLs: http://127.0.0.1:43553/api/events and http://127.0.0.1:43875/api/events.

## Diagnostic boundary
The source has a 15000ms event keepalive and no explicit server idleTimeout was found in the inspected serving configuration. This is a diagnostic clue only; root cause remains unconfirmed and no timeout fix was applied.

## Baseline and scope
Severity P2; pre-existing. Reproduced with the updated dependency candidate/Bun 1.4.2 and independently installed f64c41c9 package/Bun 1.3.14. Both used the same Playwright Chromium driver and isolated synthetic config/data/cache/collection directories with GNO_OFFLINE=1. No real collection was modified. This is a follow-up observation, not a newly introduced dependency regression.

## Traceability
Spec: fn-154-gno-20-release-dependency-sweep-and; R3 affected live-surface validation. R3 requires "Run frozen install, lint, typecheck, tests, docs, package, retrieval and affected live surfaces; validate native changes on CUDA and CI." The specific expected behavior below is a general UI expectation, not a new fn-154 feature requirement. Driver: existing-repository Playwright browser harness. Curated evidence is gzip-compressed; inspect text with gzip -dc and decompress PNGs into an access-controlled cache before viewing.

## Reproduction harness
- Candidate: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-observed-idle.ts.gz and web-observed-idle.log.gz.
- Baseline: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-baseline-idle.ts.gz and web-baseline-idle.log.gz.
- Source artifact inventory: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/manifest.json.
