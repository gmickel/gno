---
title: Reader opens a relative Markdown note link and receives 404
date: "2026-09-05"
track: bug
category: integration
module: src/serve/public/components/editor/MarkdownPreview.tsx
tags: [qa, fn-154, markdown-links]
problem_type: integration
symptoms: Rendered projects/roadmap.md link navigates to origin /projects/roadmap.md and returns 404
root_cause: (observed via live QA - unconfirmed)
resolution_type: fix
---

## Problem
A reader follows a relative note link from rendered Markdown and reaches Not Found. This edge-case relative-link syntax fails on both tested revisions; other document navigation remains available.

## Steps to reproduce (cold)
1. Start an isolated GNO server on an available port, with collection notes containing smoke-note.md and projects/roadmap.md. The target contains "# Roadmap" and "Browse tree smoke folder."; index both without embeddings.
2. Open http://127.0.0.1:43553/edit?uri=gno%3A%2F%2Fnotes%2Fsmoke-note.md at 1380x880, adjusting the port to the isolated server. Append "**Saved dependency check** and [Roadmap](projects/roadmap.md)." and save with Ctrl+S.
3. Wait for save completion; verify the synthetic source file contains the appended text. Open the document and click Rendered if it opens in source view. Wait for the bold text and Roadmap anchor.
4. Click the first link named Roadmap in the rendered document, not the separately resolved outgoing-link sidebar entry.
5. Observe the resulting URL, response status and page. Repeat against the independent baseline package with the same fixtures.

## Expected
Following a relative link to an indexed sibling note opens that note through GNO's document route, without resolving its filesystem-relative target against the app's URL root. This expectation concerns relative Markdown links only.

## Actual
The anchor href is projects/roadmap.md. Candidate navigation reaches http://127.0.0.1:43553/projects/roadmap.md; baseline reaches http://127.0.0.1:43875/projects/roadmap.md. Both return HTTP404 and a plain Not Found page. Browser console: "Failed to load resource: the server responded with a status of 404 (Not Found)". Saved source content persisted correctly before navigation.

## Evidence
- Candidate screenshot: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-observed-idle/markdown-link-target.png.gz.
- Baseline screenshot: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-baseline-idle/markdown-link-target.png.gz.
- Console/network: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-observed-idle/web-events.json.gz and .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-baseline-idle/web-events.json.gz.
- Persisted edit preview: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-observed-idle/editor-desktop.png.gz; harness checks actual source-file text before navigating.

## Baseline and scope
Severity P2; pre-existing. Reproduced with the updated dependency candidate/Bun 1.4.2 and independently installed f64c41c9 package/Bun 1.3.14. Both used the same Playwright Chromium driver and isolated synthetic config/data/cache/collection directories with GNO_OFFLINE=1. No real collection was modified. This is a follow-up observation, not a newly introduced dependency regression.

## Traceability
Spec: fn-154-gno-20-release-dependency-sweep-and; R3 affected live-surface validation. R3 requires "Run frozen install, lint, typecheck, tests, docs, package, retrieval and affected live surfaces; validate native changes on CUDA and CI." The specific expected behavior below is a general UI expectation, not a new fn-154 feature requirement. Driver: existing-repository Playwright browser harness. Curated evidence is gzip-compressed; inspect text with gzip -dc and decompress PNGs into an access-controlled cache before viewing.

## Reproduction harness
- Candidate: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-observed-idle.ts.gz and web-observed-idle.log.gz.
- Baseline: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/web-baseline-idle.ts.gz and web-baseline-idle.log.gz.
- Source artifact inventory: .flow/artifacts/fn-154-gno-20-release-dependency-sweep-and/local-gates/frontend/manifest.json.
