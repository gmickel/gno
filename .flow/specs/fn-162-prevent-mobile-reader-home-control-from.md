# Prevent reader home control from obscuring visibility on mobile

## Goal & Context

Production QA for fn-153 found a cosmetic overlap on the hosted reader at a fresh 390 x 844 viewport: the fixed gno.sh home control covers most of the PUBLIC URL badge. Reproduced after a fresh reload of the public atlas sample on 6 September 2026 at deployed commit 17d71fbe6f4a4a4a7e94f6c0d6caad8f837fec6b. Note navigation remains functional. This is a separate P2 follow-up, not a publishing lifecycle release blocker.

## Scope

Adjust the mobile reader header spacing in ~/work/gno.sh so the home control and visibility label remain readable. Preserve desktop layout and the note navigation feedback shipped in fn-153.

## Acceptance Criteria

- At 390 x 844 and 375 x 812, a fresh reader load shows the home control and complete visibility label without overlap.
- Verify desktop at 1380 x 880 and all supported reader visibility labels using synthetic fixtures.
- Capture before/after browser evidence and run affected site checks.

## Evidence

- URL: https://gno.sh/share/gno/atlas
- Screenshot: /home/gordon/.cache/agent-tmp/fn153/prod-reader-mobile-fresh.png
- Reader navigation and the publishing lifecycle production smoke passed separately.
