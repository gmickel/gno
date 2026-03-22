# fn-41-document-workspace-foundation-for.3 Implement watch-driven instant reindex and external-change banners

## Description

Add a watch-driven update loop so internal edits and external file changes propagate back into GNO immediately. This task should reuse the existing sync/update/index pipeline and embed scheduler, then publish structured document/index events to active web sessions so the UI can refresh without manual reloads.

**Files:** watch service + server lifecycle files, `src/serve/server.ts`, `src/serve/routes/api.ts`, `src/serve/public/pages/DocumentEditor.tsx`, `src/serve/public/pages/DocView.tsx`, `src/serve/public/pages/Search.tsx`, `src/serve/public/pages/Browse.tsx`, docs/tests

## Acceptance

- Add a collection-root watch service that coalesces file-system events and routes them through the existing sync/update/embed pipeline instead of bespoke indexing logic.
- GNO-originated markdown/text saves feel immediate in the UI: local save state updates first, then watch/sync completes without requiring manual `gno update` or page refresh.
- External edits to an open document publish structured events to the browser (SSE or equivalent) and render a non-destructive banner with reload/review options.
- Search, browse, and doc surfaces refresh changed metadata/content predictably after watch-driven updates; self-triggered no-op loops are suppressed with path/version-aware coalescing.
- `docs/WEB-UI.md`, `website/features/web-ui.md`, `website/_data/features.yml`, and homepage copy are updated to describe instant reindex and external-edit banners accurately instead of generic auto-save language only.
- Tests cover event coalescing, internal-save vs external-edit behavior, and event payload shape; docs are updated.

## Notes For Implementer

- There is currently no watcher layer in `src/`; server lifecycle today is DB/context/scheduler only: `src/serve/server.ts:119-205`.
- Reuse embed-scheduler and current sync primitives instead of introducing a second indexing path.
- External-change banner UX should build on the conflict/version model from task `.2`, not invent a parallel state machine.
- Current website Web UI copy and feature data will drift without explicit edits: `website/features/web-ui.md:34-57`, `website/_data/features.yml:56-74`.

## Done summary

Added document event streaming, collection watch service, search/browse live refresh, and DocView/Editor external-change banners.

## Evidence

- Commits: e677f41, 2662e77
- Tests: bun test, bun run lint:check, bun run docs:verify
- PRs:
