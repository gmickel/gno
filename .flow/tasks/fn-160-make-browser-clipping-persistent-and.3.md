---
satisfies: [R1, R2, R5]
---
# fn-160-make-browser-clipping-persistent-and.3 Integrate remembered collection picker

## Description
**Size:** M
**Touches:** [browser-extension/src/storage.ts, browser-extension/src/controller.ts, browser-extension/src/gateway.ts, browser-extension/src/contracts.ts, browser-extension/src/types.ts, browser-extension/src/service-worker.ts, browser-extension/src/preview.tsx, browser-extension/test/storage.test.ts, browser-extension/test/controller.test.ts, browser-extension/test/preview-workflow.dom.test.tsx]
**Approach:** Use a separate versioned local preference key scoped by gateway to avoid invalidating the strict existing grant/pending schema. Fetch the minimal paired catalog and render an accessible picker with actionable states. Remember explicit selection immediately; revalidate on restore. Pending recovery wins over reusable preferences.

## Acceptance
- [ ] Reopen/restart, gateway change, corrupt storage, removed collection and offline-list cases pass.
- [ ] No silent fallback destination; old grants/pending writes survive migration.
- [ ] Destination changes invalidate outstanding previews and stale catalog responses.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
