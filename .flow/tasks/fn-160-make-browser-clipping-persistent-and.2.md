---
satisfies: [R3, R4, R5]
---
# fn-160-make-browser-clipping-persistent-and.2 Move capture into a persistent source-bound side panel

## Description
**Size:** M
**Touches:** [browser-extension/manifest.json, browser-extension/src/chrome-api.d.ts, browser-extension/src/service-worker.ts, browser-extension/src/types.ts, browser-extension/src/preview.tsx, browser-extension/src/preview.css, browser-extension/test/manifest.test.ts, browser-extension/test/source-session.test.ts]
**Approach:** Replace popup entry with user-gesture side-panel opening; reuse existing preview app and recovery. Bind extraction to explicit source identity and reject stale responses. Support narrow/resizable panel layout. Read manifest, service-worker EXTRACT, preview invalidation and official Chrome sidePanel/activeTab docs before edits.

## Acceptance
- [ ] Actual browser selection works with panel open and draft retained.
- [ ] Tab/window/navigation/permission races reject stale or wrong-source captures.
- [ ] Pending recovery and explicit write confirmation remain intact.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
