---
title: Publisher cannot finish encrypted export in a short window
date: "2026-09-06"
track: bug
category: ui
module: src/serve/public/components/PublishExportDialog.tsx
tags: [qa, fn-153-publishing-permissions-public, export]
problem_type: ui
symptoms: Unbounded encrypted dialog dismisses when audience checkbox lies outside short viewport
root_cause: New dialog sizing utilities absent from generated production CSS; confirmed by computed style
resolution_type: fix
related_to: [bug/ui/mobile-collections-page-overflows-a-2026-09-05, bug/ui/mobile-graph-reader-sees-465px-page-2026-09-05, bug/ui/mobile-user-sees-clipped-docview-960px-2026-08-03]
---

## Problem
Local publisher cannot finish encrypted export in a short window: the form extends outside the viewport and clicking audience acknowledgment dismisses it.

## Steps to reproduce (cold)
1. Open http://127.0.0.1:3300/collections at 1280x633 with the synthetic harbor-qa collection.
2. Collection menu -> Export for gno.sh -> Encrypted.
3. Fill both passphrase inputs with the same synthetic test passphrase.
4. Click the audience acknowledgment checkbox.
5. The dialog closes without an export POST. Reproduced twice with refreshed element references. At1280x800 it stays open and export succeeds, but heading/footer are clipped.

## Expected
R1: "Note and collection export dialogs require an explicit access choice and export that mode." R6: "Desktop, mobile, and keyboard journeys are usable."

## Actual
Short viewport cannot reach a stable complete encrypted review. At1280x800, the panel spans almost the full viewport and extends beyond its top and bottom. Worker independently observed computed maxHeight none at1280x633; missing production CSS utilities confirmed.

## Evidence
- Screenshot: .flow/tmp/qa-fn-153-publishing-permissions-public/host-encrypted-form-1280.png
- URL: http://127.0.0.1:3300/collections
- Write side effect: no /api/publish/export request in either failed short-height attempt. Later1280x800 successful request200 downloaded v2 encrypted artifact to isolated scratch.
- Console: .flow/tmp/qa-fn-153-publishing-permissions-public/S1-console.log

## Traceability
- R-IDs: R1,R6,R7; scenario S1; driver agent-browser0.35.1; viewports1280x633 and1280x800.
- Severity P1: export requires a larger window as workaround.
- Classification introduced; confidence100.

## Resolution
Fixed in GNO 525d2c75. The production dialog now bounds its panel, scrolls the form body, and retains the header and actions. The SPA builder rebuilds CSS before bundling. Real encrypted downloads passed at 1280x633 and 375x633; screenshots worker-export-after-1280x633.png and worker-export-after-375x633.png in the same QA directory. Final full suite: 5233 passed, 2 expected skips, zero failures.
