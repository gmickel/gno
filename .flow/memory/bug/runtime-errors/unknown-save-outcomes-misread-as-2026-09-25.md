---
title: Unknown save outcomes misread as definitive rejections in the editor
date: "2026-09-25"
track: bug
category: runtime-errors
module: src/serve/public/pages/DocumentEditor.tsx
tags: [fn-182, request-receipts, web-ui, retry]
problem_type: runtime-error
symptoms: Lost or pending save later shown as an outside change on disk
root_cause: Only thrown fetches marked outcome unknown; failed verification read treated as hash mismatch
resolution_type: fix
related_to: [bug/runtime-errors/doc-view-logs-a-503-console-error-on-2026-09-02]
---

## Problem
The editor treated only a thrown fetch as an unknown save outcome. An unreadable body, a 5xx, or a `REQUEST_PENDING` retry was read as a definitive rejection, so the save's own change event was later blamed on an outside writer. A replay whose verification read failed also showed the outside-change banner with no evidence.

## What Didn't Work
A `noResponse` flag set only in apiFetch's catch branch; it missed every answered-but-inconclusive response.

## Solution
apiFetch sets `outcomeUnknown` for thrown fetches, unparseable responses, and HTTP errors classified by `writeOutcomeUnknown(status, code)` in `src/serve/public/lib/request-intent.ts` (5xx or `REQUEST_PENDING`). The editor shows the outside banner only when a successful read shows a different hash.

## Prevention
For any retry-safe write UI, enumerate every response class (thrown, unreadable, 5xx, pending, definitive 4xx) and test each. "Absence of evidence" (a failed read) is never evidence of an outside change. Bun's `mock.module` for `hooks/use-api` is sticky across files, so put testable classification in a pure lib module.
