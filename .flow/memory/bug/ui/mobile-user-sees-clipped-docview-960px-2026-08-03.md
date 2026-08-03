---
title: Mobile user sees clipped DocView — 960px canvas overflows 375px viewport
date: "2026-08-03"
track: bug
category: ui
module: src/serve/public/pages/DocView.tsx
tags: [qa, fn-61-document-structure-navigation-and-section-addressability, web-ui, mobile]
problem_type: ui
symptoms: "DocView reports 960px scroll width at a 375px viewport, clipping header actions and forcing 585px horizontal overflow."
root_cause: (observed via live QA — unconfirmed)
resolution_type: fix
---

## Problem

A mobile-width user opening DocView sees a desktop-width canvas clipped behind horizontal scrolling; header actions extend off-screen.

## Steps to reproduce (cold)

1. Start `gno serve` with an indexed Markdown document and open `/doc?uri=<document>&view=rendered`.
2. Set the browser viewport to 375 x 812.
3. Wait for the document to render.
4. Observe the horizontal scrollbar and measure `document.documentElement.scrollWidth`.
5. Reload and repeat.

## Expected

The document view should remain usable at the QA mobile viewport without a desktop-width canvas forcing horizontal scrolling.

## Actual

Both runs reported `innerWidth: 375`, `scrollWidth: 960`, and `overflow: 585`; header actions are clipped. Document content and QuickSwitcher section navigation remain usable.

## Evidence

- console: `.flow/tmp/qa-fn-61-document-structure-navigation-and-section-addressability/S7-mobile-console.log`
- screenshot: `.flow/tmp/qa-fn-61-document-structure-navigation-and-section-addressability/S7-mobile.png`
- follow-up screenshot: `.flow/tmp/qa-fn-61-document-structure-navigation-and-section-addressability/S8-mobile-switcher.png`
- URL: `http://127.0.0.1:3331/doc?uri=gno%3A%2F%2Ffn61qa%2Fguide.md&view=rendered`
- repeated measurement: `innerWidth=375`, `scrollWidth=960`, `overflow=585`

## Traceability

- R-IDs: [R3, R6]
- scenario: S14
- driver_rung: agent-browser
- viewport: 375x812
- classification: pre_existing
- severity: P2
