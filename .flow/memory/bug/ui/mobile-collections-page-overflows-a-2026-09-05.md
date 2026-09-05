---
title: Mobile Collections page overflows a 375px viewport by 90px
date: "2026-09-05"
track: bug
category: ui
module: src/serve/public/pages/Collections.tsx
tags: [qa, fn-152, mobile]
problem_type: ui
symptoms: Collections scrollWidth465 at innerWidth375 on two page loads
root_cause: Observed via live QA; root cause unconfirmed
resolution_type: fix
related_to: [bug/ui/mobile-user-sees-clipped-docview-960px-2026-08-03]
---

## Problem
Mobile users viewing Collections receive a page wider than their viewport. Severity P2; the tested indexing controls remain usable. Observed twice during fn-152 QA; no layout fix is included in the polling task.

## Steps to reproduce (cold)
1. Run an isolated current-source GNO server with one synthetic collection and open /collections in Chromium at 375x812.
2. Click Re-index All and observe the indexing panel. The QA proxy supplies a running job without changing real indexed data.
3. Read document.documentElement.scrollWidth and window.innerWidth.
4. Repeat with a fresh page load at the same viewport.

## Expected
The Collections page fits the viewport without horizontal document overflow. This is a general layout expectation, outside fn-152 polling-lifetime R-IDs.

## Actual
Both observations report scrollWidth 465 and viewport width 375. The current polling lifecycle passes. Header overlap seen in an earlier scrolled screenshot did not reproduce on a fresh load and is not a confirmed finding.

## Evidence
- screenshot: .flow/tmp/qa-fn-152-stop-indexing-polling-after-component/mobile-repeat-layout.png
- dimensions: .flow/tmp/qa-fn-152-stop-indexing-polling-after-component/mobile-repeat-dimensions.log
- first observation: .flow/tmp/qa-fn-152-stop-indexing-polling-after-component/mobile-dimensions.log
- console and page errors: .flow/tmp/qa-fn-152-stop-indexing-polling-after-component/mobile-console.log and mobile-errors.log
- url: http://127.0.0.1:43953/collections
- no real indexing writes; synthetic job responses only.

## Traceability
R-IDs: none. Separate layout observation during fn-152. Driver: agent-browser Chromium; viewport375x812. Root cause unconfirmed. Existing layout is unchanged by fn-152; pre-existing attribution is inferred from that limited evidence.
