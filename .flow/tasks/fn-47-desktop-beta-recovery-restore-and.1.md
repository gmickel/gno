# fn-47-desktop-beta-recovery-restore-and.1 Add visible local history and restore flow

## Description

Build the first recovery/support slice on top of the existing local-history foundation.

Initial slice:

- surface a visible local-history browser for editable docs
- add one-click restore from local history with clear safety copy
- keep restore aligned with editable/read-only document capability rules
- update troubleshooting/support docs around the new self-recovery path
- add regression coverage for history persistence and restore behavior

## Acceptance

- [ ] Users can see recent local revisions for editable docs from the app
- [ ] Users can restore a prior local revision without leaving GNO
- [ ] Read-only docs do not expose invalid restore actions

## Done summary

Shipped the first recovery/restore slice.

Highlights:

- promoted local history into a visible History dialog in the editor
- added restore-selected-snapshot flow on top of the existing local snapshot model
- kept recovery scoped to editable docs instead of exposing broken actions on read-only docs
- made local history testable with injected storage and added regression coverage
- updated troubleshooting docs to point users at the self-recovery path first
- verified in-browser that the editor now exposes the visible History action

## Evidence

- Commits:
- Tests: bun test test/serve/public/local-history.test.ts test/serve/public/navigation.test.tsx, bun run lint:check, bun run typecheck, bun test, bun run docs:verify, browser sanity: agent-browser open editable doc editor on http://localhost:3131; visible History action confirmed
- PRs:
