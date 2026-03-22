# fn-45-desktop-beta-workspace-navigation.1 Add persistent recents and favorites surfaces

## Description

Build the first navigation/persistence slice for living in GNO all day.

Initial slice:

- add a persistent favorites/pins model alongside the existing recent-doc tracking
- expose recents/favorites visibly on the dashboard and/or browse surfaces, not only in Cmd/Ctrl+K
- polish quick-switcher grouping so navigation feels like a primary surface
- update docs/website copy for the new navigation model

## Acceptance

- [ ] Users can see and reopen recent or favorited items without relying on the keyboard shortcut alone
- [ ] Favorites/pins persist across reloads
- [ ] Quick-switcher and visible navigation surfaces stay aligned on the same underlying model

## Done summary
Shipped the first persistent navigation slice.

Highlights:
- extracted shared storage-backed navigation state for recent docs, favorite docs, and pinned collections
- wired QuickSwitcher to the shared recents/favorites model
- added visible recent/favorite surfaces on the dashboard
- added pin/favorite controls in browse and dashboard collection surfaces
- updated docs/website copy for the new navigation model
- verified in-browser that favorites/recents show up on the dashboard outside the hidden quick-switcher
## Evidence
- Commits:
- Tests: bun test test/serve/public/navigation-state.test.ts test/serve/public/navigation.test.tsx, bun run lint:check, bun run typecheck, bun test, bun run docs:verify, browser sanity: agent-browser open http://localhost:3128/browse then /; favorites/recents visible on dashboard
- PRs: