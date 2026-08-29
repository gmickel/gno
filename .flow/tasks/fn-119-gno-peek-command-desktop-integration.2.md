---
satisfies: [R2]
---
# fn-119-gno-peek-command-desktop-integration.2 Freeze deep-link and search source-path

## Description
Freeze the R2 open/deep-link contract: documented `{serveUrl}/doc?uri=<encodeURIComponent(uri)>` (optional `#anchor`) and a documented source-path field on `gno search --json` so open-file needs no `gno get`. Split from peek so the URL template and search field are independently reviewable.

**Size:** S
**Files:** spec/cli.md; spec/output-schemas/search-results.schema.json; test/spec/schemas/search-result.test.ts; docs/WEB-UI.md; docs/API.md; docs/CLI.md
**Touches:** spec/cli.md; spec/output-schemas/search-results.schema.json; test/spec/schemas/search-result.test.ts; docs/WEB-UI.md; docs/API.md; docs/CLI.md; src/pipeline/search.ts; src/cli/commands/search.ts; src/cli/format/search-results.ts

### Approach
- Web-UI template already exists: `buildDocDeepLink` (`src/serve/public/lib/deep-links.ts:17`) and SPA route `/doc` (`src/serve/server.ts:409`). Do not add a CLI resolver. Document the frozen template as stable across releases in `docs/WEB-UI.md` (near the existing `/doc?uri=` mentions ~623 and ~697) and `docs/API.md` (distinguish page URL `{serveUrl}/doc?uri=` from REST `GET /api/doc?uri=` ~1268).
- Unknown URIs stay on the web UI's own not-found path — no new CLI error surface.
- Search source-path: `src/pipeline/search.ts:102` already sets `source.absPath` when collection path + relPath exist; `formatSearchResults` JSON is a full `JSON.stringify` (`src/cli/format/search-results.ts:45`). CLI search has **no** `--source` flag (`spec/cli.md` search ~1104). Treat `results[].source.absPath` as the documented default field (optional when unresolvable). Update the schema description (today it says "included with --source or in MCP" — that comment is stale) and add a contract assertion in `test/spec/schemas/search-result.test.ts` for present vs absent `absPath`.
- Document the field + fallback (URI tail for display; disable file-open when absent) in `spec/cli.md` search JSON notes and `docs/CLI.md` search section.
- If live `gno search --json` on a real index omits `absPath` for ordinary file-backed hits, fix the CLI/pipeline path — do not add a new flag unless the default field cannot be populated.

### Investigation targets
**Required** (read before coding):
- `.flow/specs/fn-119-gno-peek-command-desktop-integration.md`
- `src/serve/public/lib/deep-links.ts`
- `src/serve/server.ts`
- `docs/WEB-UI.md`
- `docs/API.md`
- `spec/output-schemas/search-results.schema.json`
- `src/pipeline/search.ts`
**Optional**:
- `src/cli/format/search-results.ts`
- `spec/cli.md`
- `docs/CLI.md`
- `src/serve/security.ts`

### Key context
R2 allows "documented flag or default field". Prefer documenting the existing default `source.absPath`; do not invent `--source` on search. `serve.url` from peek (task 1) is the `{serveUrl}` prefix for live QA. Bind is loopback (`127.0.0.1`); operator-facing URL in this repo is `http://localhost:${port}`.

## Acceptance
- [ ] WEB-UI + API docs freeze `{serveUrl}/doc?uri=<encodeURIComponent(uri)>` (optional `#anchor`) as stable; unknown URIs use the UI not-found path; no CLI resolver.
- [ ] `gno search --json` documents `results[].source.absPath`; schema/contract tests cover present and absent; absent → display fallback + no file-open (consumer rule, documented).
- [ ] Live evidence: real `gno search --json` showing `absPath` on a file-backed hit (and a row without it if one exists); real curl/browser GET of `{peek.serve.url}/doc?uri=<encoded>` for a known URI (document loads) and an unknown URI (UI not-found, not a CLI error). Save URLs + response/status.

## Done summary
Froze the R2 open/deep-link contract: documented `{serveUrl}/doc?uri=<encodeURIComponent(uri)>` (optional `#anchor`) as stable versus REST `GET /api/doc`, and documented `results[].source.absPath` as the default `gno search --json` source-path field with present/absent schema tests. Live search on the 1673-doc index returned absPath on all 5 file-backed hits; isolated serve at http://localhost:3458 loaded a known URI and showed UI/REST not-found for an unknown URI (no CLI error).
## Evidence
- Commits: 46513d6b2e1dafea57f620f4e65df43eb3c435b3
- Tests: bun test test/spec/schemas/search-result.test.ts, bun test test/cli/search-results-format.test.ts
- PRs: