# fn-41-document-workspace-foundation-for.2 Add conflict-safe editing and local history

## Description

Replace the current blind-save editor flow with a versioned save protocol and recoverable local history. The editor should submit expected source metadata on save, detect stale writes explicitly, and offer recovery/restore paths instead of silently overwriting newer on-disk state.

**Files:** `src/serve/routes/api.ts`, `src/serve/public/pages/DocumentEditor.tsx`, `src/serve/public/components/ui/dialog.tsx`, storage/history support files, `docs/API.md`, `docs/WEB-UI.md`, related specs/tests

## Acceptance

- Update the document update contract to accept expected version markers (`sourceHash`, modified time, or equivalent) and return conflict-specific payloads when a save is stale.
- DocumentEditor submits version markers on save, refreshes its local baseline after successful writes, and surfaces save conflicts with clear reload/restore/review choices using existing dialog primitives.
- Add bounded local history for user-authored editable documents so recent revisions can be restored after conflict or mistaken edits.
- Silent overwrite is no longer possible when the file changed on disk after the editor loaded it; regression tests cover stale saves, restore flow, and sequential successful saves.
- API/Web docs and any affected schemas/specs are updated.

## Notes For Implementer

- Current save flow has no optimistic concurrency markers: `src/serve/public/pages/DocumentEditor.tsx:223-255`.
- Existing unsaved-change dialog can be extended rather than replaced: `src/serve/public/pages/DocumentEditor.tsx:394-430`, `src/serve/public/components/ui/dialog.tsx:1-142`.
- Keep history/restore scoped to editable docs only; converted read-only assets are handled by task `.1`.
