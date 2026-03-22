# fn-41-document-workspace-foundation-for.4 Standardize deep links and exact-hit navigation

## Description

Define one canonical deep-link contract for documents, headings, and line targets, then use it consistently across the web app, API, MCP, and SDK. Search hits should open directly to the exact relevant location instead of only to the document root.

**Files:** `src/serve/public/app.tsx`, `src/serve/public/pages/Search.tsx`, `src/serve/public/pages/DocView.tsx`, `src/serve/public/pages/DocumentEditor.tsx`, API/MCP/SDK output files, docs/specs/tests

## Acceptance

- Define one canonical deep-link shape covering document URI plus optional mode, heading anchor, line target, and/or line range.
- Search results use existing `snippetRange` metadata to navigate to the exact hit location rather than only `/doc?uri=...`.
- Doc View and editor honor deep-link params by scrolling/highlighting the resolved heading/line target and expose copy-link affordances.
- API/MCP/SDK surfaces return enough target metadata to reconstruct or emit stable deep links without client-side guesswork.
- Contract tests/docs/specs are updated, and the resulting link shape is documented in the API/MCP/SDK/Web docs as the substrate for task `.6` `Cmd/Ctrl+K` workspace switching.

## Notes For Implementer

- Current search click behavior ignores `snippetRange`: `src/serve/public/pages/Search.tsx:1035-1067`.
- Current SPA query-string handling is already stable enough to extend: `src/serve/public/app.tsx:40-60`.
- Keep deep-link behavior compatible with the existing shadcn command/dialog primitives used by task `.6`: `src/serve/public/components/ui/command.tsx:1-183`.
- This task should explicitly touch `docs/API.md`, `docs/MCP.md`, `docs/SDK.md`, and any website/API feature copy that mirrors linkable result payloads.

## Done summary

Standardized deep-link helpers, exact-hit navigation from search, source-line highlighting, copy-link actions, and updated get/mcp/spec contracts.

## Evidence

- Commits: e677f41, 2662e77
- Tests: bun test, bun run lint:check
- PRs:
