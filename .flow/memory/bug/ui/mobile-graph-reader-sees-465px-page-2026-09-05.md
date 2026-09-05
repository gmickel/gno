---
title: Mobile graph reader sees 465px page width in a 375px viewport
date: "2026-09-05"
track: bug
category: ui
module: src/serve/public/pages/GraphView.tsx
tags: [qa, fn-154, mobile, graph]
problem_type: ui
symptoms: Graph page scrollWidth 465 at innerWidth375 clips the mobile layout on both revisions
root_cause: (observed via live QA - unconfirmed)
resolution_type: fix
related_to: [bug/ui/mobile-collections-page-overflows-a-2026-09-05, bug/ui/mobile-user-sees-clipped-docview-960px-2026-08-03]
---

## Problem
A mobile graph reader receives a page wider than the viewport. The graph canvas renders nodes and a link, but the overall page extends 90px beyond the viewport. Severity P2; the graph remains visible.

## Steps to reproduce (cold)
1. Start an isolated GNO server with two indexed Markdown notes linked to each other; the harness creates notes/smoke-note.md and notes/projects/roadmap.md.
2. Set Chromium viewport to 375x812 and open http://127.0.0.1:43553/graph, adjusting the port to the isolated server.
3. Wait for the graph canvas to appear. Capture the full page, then evaluate document.documentElement.scrollWidth and window.innerWidth.
4. Repeat on the independent baseline package at http://127.0.0.1:43875/graph with the same fixture and viewport.

## Expected
Graph navigation and page layout fit a 375px viewport without horizontal document overflow.

## Actual
Both runs report viewport 375 and scrollWidth 465. The screenshot shows graph nodes rendered while header/footer layout extends beyond the viewport. This reproduces the previously noted mobile graph limitation; it is not fixed by the dependency sweep.

## Evidence
- Candidate screenshot: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-observed-idle/graph-mobile.png.gz.
- Baseline screenshot: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-baseline-idle/graph-mobile.png.gz.
- Exact dimensions and URLs: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-observed-idle.log.gz and .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-baseline-idle.log.gz.
- Console/network: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-observed-idle/web-events.json.gz and .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-baseline-idle/web-events.json.gz; preceding relative-link and document-idle errors are separately filed, not attributed to graph rendering.

## Related observations
- bug/ui/mobile-collections-page-overflows-a-2026-09-05: same 465/375 dimensions on Collections.
- bug/ui/mobile-user-sees-clipped-docview-960px-2026-08-03: different DocView overflow dimensions.
These entries were inspected before filing. No existing graph-specific entry was found; shared root cause is unconfirmed, so their original observations and dispositions remain unchanged.

## Baseline and scope
Severity P2; pre-existing. Reproduced with the updated dependency candidate/Bun 1.4.2 and independently installed f64c41c9 package/Bun 1.3.14. Both used the same Playwright Chromium driver and isolated synthetic config/data/cache/collection directories with GNO_OFFLINE=1. No real collection was modified. This is a follow-up observation, not a newly introduced dependency regression.

## Traceability
Spec: fn-154-gno-20-release-dependency-sweep-and; R3 affected live-surface validation. R3 requires "Run frozen install, lint, typecheck, tests, docs, package, retrieval and affected live surfaces; validate native changes on CUDA and CI." The specific expected behavior below is a general UI expectation, not a new fn-154 feature requirement. Driver: existing-repository Playwright browser harness. Curated evidence is gzip-compressed; inspect text with gzip -dc and decompress PNGs into an access-controlled cache before viewing.

## Reproduction harness
- Candidate: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-observed-idle.ts.gz and web-observed-idle.log.gz.
- Baseline: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-baseline-idle.ts.gz and web-baseline-idle.log.gz.
- Source artifact inventory: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/manifest.json.
