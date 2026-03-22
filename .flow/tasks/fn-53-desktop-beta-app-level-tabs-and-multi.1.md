# fn-53-desktop-beta-app-level-tabs-and-multi.1 Add persistent app-level tab workspace foundation

## Description

Build the first app-level tab workspace slice inside the existing React app.

Initial slice:

- add persistent tab/workspace state for core views (doc, edit, search, browse, ask, graph)
- add a visible tab strip with activate/close/new-tab basics
- restore the last workspace session on reload
- keep current deep-link/doc routes working through the new tab model instead of replacing them
- add tests/docs for tab persistence and visible workspace navigation

## Acceptance

- [ ] Users can keep multiple app-level tabs open and switch between them in the visible workspace
- [ ] Tab state survives reload via session restore
- [ ] Existing deep-link/doc navigation still works on top of the tab model

## Done summary
Shipped the first app-level tab workspace foundation.

Highlights:
- added persistent workspace tab state with session restore
- added a visible app-level tab strip with activate/close/new-tab basics
- kept current route/deep-link navigation working on top of the tab model
- documented the app-level tab direction in docs/website copy
- verified in-browser that multiple tabs open inside the existing workspace
## Evidence
- Commits:
- Tests: bun test test/serve/public/workspace-tabs.test.ts test/serve/public/navigation.test.tsx, bun run lint:check, bun run typecheck, bun test, bun run docs:verify, browser sanity: agent-browser open http://localhost:3129/ then open a second tab via New Tab; visible multiple tabs confirmed
- PRs: