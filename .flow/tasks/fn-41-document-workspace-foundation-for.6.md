# fn-41-document-workspace-foundation-for.6 Build the fast Cmd/Ctrl+K workspace switcher

## Description

Build a keyboard-first `Cmd/Ctrl+K` workspace switcher using the existing shadcn/cmdk command primitive, the current fast BM25 path, and the deep-link/watch foundations from tasks `.3` and `.4`. The result should let users open or create notes without context-switching away from GNO.

**Files:** `src/serve/public/app.tsx`, new palette/switcher component files, `src/serve/public/components/ui/command.tsx`, `src/serve/public/pages/Search.tsx`, deep-link helpers, docs/tests

## Acceptance

- Add a global `Cmd/Ctrl+K` / `Ctrl+K` shortcut that opens a workspace switcher without conflicting with editor-local shortcuts.
- The switcher uses the existing fast BM25 retrieval path for responsive title/path lookup and respects the current fresh index state from task `.3`.
- Results can open exact deep-linked document targets from task `.4`, not just root document routes.
- The switcher supports at least: open matching note, open recent note, and create new markdown note.
- The UI is built with the existing shadcn/cmdk command/dialog primitives already in the repo; docs/tests cover shortcut behavior, result navigation, create-note flow, and website/homepage/feature copy for the new switcher.

## Notes For Implementer

- Reuse the existing command/dialog primitive instead of introducing another palette stack: `src/serve/public/components/ui/command.tsx:1-183`.
- Reuse the current fast BM25 path rather than inventing a second local fuzzy index: `src/serve/public/pages/Search.tsx:341-346`.
- Current app-level shortcuts only cover `/` and `?`, so add the new global entrypoint there: `src/serve/public/app.tsx:63-89`.
- This task depends on the watch/event and deep-link contracts from tasks `.3` and `.4`; do not invent parallel routing or stale local caches inside the switcher.
- Desktop shell work remains deferred follow-on scope; keep `fn-7` as the later home for OS-level packaging/file association.
- Current website feature data already claims `Cmd+K`, so this task must reconcile homepage/feature/FAQ copy with the actual shipped shortcut behavior: `website/_data/features.yml:56-74`, `website/index.md:83-105`.

## Done summary
Built the fast Cmd/Ctrl+K quick switcher with recent-doc tracking, fast BM25 lookup, deep-link navigation, and note creation handoff.
## Evidence
- Commits: e677f41, 2662e77
- Tests: bun test, bun run lint:check, bun run docs:verify
- PRs: