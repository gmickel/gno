---
title: Encrypted collection shows misleading content counts
date: "2026-09-06"
track: bug
category: ui
module: gno.sh/src/components/studio/publish-studio.tsx
tags: [qa, fn-153-publishing-permissions-public, encrypted]
problem_type: ui
symptoms: Encrypted collection displayed placeholder note and asset counts
root_cause: Studio treated encrypted envelope rows as plaintext content counts
resolution_type: fix
related_to: [bug/ui/mobile-collections-page-overflows-a-2026-09-05, bug/ui/mobile-graph-reader-sees-465px-page-2026-09-05, bug/ui/mobile-user-sees-clipped-docview-960px-2026-08-03, bug/ui/publisher-cannot-finish-encrypted-2026-09-06]
---

## Problem
Studio showed an encrypted two-note collection as 1 note and 0 assets. Placeholder storage rows cannot describe encrypted contents. Reproduced in the Team library before and after navigation; decrypted reader showed two notes. R6/R10/R11, scenario S6, P2 introduced, confidence 100.

## Resolution
Fixed in gno.sh 3e93e13. Library and review say content counts are unavailable. Delete confirmation distinguishes separately stored objects from unknown embedded counts. Live refresh retained honest wording, and deletion was canceled without changing the fixture.

## Evidence
/home/gordon/.cache/agent-tmp/fn153/studio-encrypted-count-library.png
/home/gordon/.cache/agent-tmp/fn153/studio-encrypted-count-delete-review.png
/home/gordon/.cache/agent-tmp/fn153/studio-encrypted-count-refresh.txt
22 focused Studio tests and the final 329-test hosted suite passed.
