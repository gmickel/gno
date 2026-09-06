---
satisfies: [R4, R5]
---
# fn-136-pdf-viewing-over-a-remote-link.2 localClient capability and locality-aware document actions

## Description
Implement R4 and R5. Report `localClient` from `/api/capabilities` using the peer address, Host header, and forwarding headers, refuse the reveal endpoint for non-local clients, then gate both "Reveal" sites and the `file://` "Open original" on it in the document view and give remote clients an inline asset link instead. Depends on task .1 because both edit `api.ts` and `server.ts`.

**Size:** M
**Files:** `src/serve/routes/api.ts` (handleCapabilities, reveal handler), `src/serve/server.ts` (capabilities and reveal routes), `src/serve/request-locality.ts` (new: loopback predicate moved out of `clipper-security.ts` plus the request-locality function), `src/serve/clipper-security.ts` (import the moved predicate), `src/serve/public/lib/server-capabilities.ts` (new shared client type and fetch helper), `src/serve/public/pages/DocView.tsx`, `src/serve/public/pages/Ask.tsx`, `src/serve/public/pages/Search.tsx`, `test/serve/request-locality.test.ts`, `test/serve/api-capabilities.test.ts`, `test/serve/public/pages/DocView-actions.dom.test.tsx`, `docs/API.md`, `docs/WEB-UI.md`, `src/serve/CLAUDE.md`
**Touches:** [src/serve/routes/api.ts, src/serve/server.ts, src/serve/request-locality.ts, src/serve/clipper-security.ts, src/serve/public/lib/server-capabilities.ts, src/serve/public/pages/DocView.tsx, src/serve/public/pages/Ask.tsx, src/serve/public/pages/Search.tsx, test/serve/request-locality.test.ts, test/serve/api-capabilities.test.ts, test/serve/public/pages/DocView-actions.dom.test.tsx, docs/API.md, docs/WEB-UI.md, src/serve/CLAUDE.md]

### Approach
- Move the loopback predicate at `src/serve/clipper-security.ts:147-158` into `src/serve/request-locality.ts` and add a request-locality function `(request, server) -> boolean` that applies the three-part rule in the spec's API Contracts: peer via `server.requestIP(request)` (pattern at `clipper-security.ts:372`), the host part of the Host header, and the absence of `Forwarded` and `X-Forwarded-*` headers. The clipper boundary imports the moved predicate; its behaviour does not change.
- Widen the capabilities route at `src/serve/server.ts:1017-1020` to pass `req` and the Bun server into `handleCapabilities` (`src/serve/routes/api.ts:4883-4890`) and add the boolean to its response.
- Apply the same locality function to the reveal route (`server.ts:826-837` region, handler near `api.ts:3123-3160`): a non-local client gets 403 with the existing error envelope before `revealFilePath` runs. Hiding the button is not access control.
- Create one shared client `ServerCapabilities` type plus a small fetch helper in `src/serve/public/lib/server-capabilities.ts` and replace the duplicated interfaces in `Ask.tsx:107` and `Search.tsx:124`. Note `doc.capabilities` in DocView (`DocView.tsx:185-191`) is a per-document shape; name the new state `serverCapabilities`.
- In `DocView.tsx` fetch server capabilities once per mount, default to remote on failure, and gate both Reveal sites (`:1820-1832`, `:1847-1858`) and the `file://` link (`:1834-1841`). For remote clients render "Open original" as `<a href={pdfAssetUrl} target="_blank" rel="noopener">` with the existing outline button styling; keep "Download original" (`:1860-1871`, `:2099-2110`) as is.
- Tests: `test/serve/request-locality.test.ts` covers the locality matrix (loopback peer + localhost Host → true; loopback peer + non-loopback Host → false; loopback peer + `X-Forwarded-For` → false; non-loopback peer → false; IPv4-mapped loopback → true) using the fake-server `requestIP` double from `test/clipper/routes.test.ts:53`; `test/serve/api-capabilities.test.ts` covers the response field and the reveal 403/200 pair; the DocView dom test covers local vs remote button sets and the fetch-failure default.
- Docs: `docs/API.md` Capabilities section (line about 662-687) and the reveal endpoint's 403, `docs/WEB-UI.md` reveal wording (line about 347-364) and the Security table caveat (line about 933-967), `src/serve/CLAUDE.md` endpoint table.

### Investigation targets
**Required** (read before coding):
- `src/serve/clipper-security.ts:140-160` and `:360-392` — loopback predicate and requestIP usage
- `src/serve/server.ts:820-840` and `:1010-1025` — reveal and capabilities route signatures
- `src/serve/public/pages/DocView.tsx:540-560` and `:1815-1875` — isPdf, pdfAssetUrl, and the action buttons
- `test/clipper/routes.test.ts:40-70` — fake server double with requestIP

**Optional** (reference as needed):
- `src/serve/public/pages/Ask.tsx:100-115`, `Search.tsx:120-130` — duplicated Capabilities interfaces to consolidate
- `docs/adr/001-scholarly-dusk-design-system.md` — button styling rules

### Design context
Keep the existing outline `Button` variant and icon size for the header action row; do not introduce a new button style for the remote "Open original" link. Full design system: `docs/adr/001-scholarly-dusk-design-system.md`.

### Key context
- `gno serve` refuses non-loopback binds, so a remote client always arrives through a same-host proxy with a loopback peer. Forwarding headers may only ever make a client remote, never local.
- The capabilities call is net-new in DocView; nothing there fetches `/api/capabilities` today.
## Acceptance
- [ ] `/api/capabilities` returns `localClient` per the three-part rule; the locality matrix tests (localhost Host, non-loopback Host, forwarded header, non-loopback peer, IPv4-mapped loopback) pass
- [ ] `POST /api/docs/:id/reveal` returns 403 with the existing error envelope for a non-local client and still works for a local one
- [ ] Local client: both Reveal sites and the `file://` Open original render; remote client: all three hidden, Open original is an inline `/api/doc-asset` link in a new tab with `rel="noopener"`; Download original unchanged
- [ ] Capabilities fetch failure treats the client as remote
- [ ] One shared client capabilities type; Ask and Search compile against it; the clipper boundary behaves exactly as before (existing clipper tests pass)
- [ ] CSP and frame headers unchanged; `docs/API.md`, `docs/WEB-UI.md`, `src/serve/CLAUDE.md` updated; `bun test` and `bun run lint:check` pass
## Done summary
Implemented R4 and R5. `/api/capabilities` reports `localClient` from a fail-closed request-locality rule (loopback peer + loopback Host + no forwarding headers), the loopback predicate moved out of the clipper security boundary into a shared module with its old name kept as an alias, and the reveal endpoint refuses non-local clients with a 403 FORBIDDEN envelope before resolving the document. DocView gates both Reveal sites and the `file://` Open original on the flag; remote clients get an inline `/api/doc-asset` link in a new tab with `rel="noopener"`; Download original is unchanged; a failed capabilities read counts as remote. One shared `ServerCapabilities` type plus `fetchServerCapabilities()` replaces the duplicated Ask/Search interfaces. docs/API.md, docs/WEB-UI.md, and src/serve/CLAUDE.md updated.

Review: SHIP on round 1 (Opus, host backend). Its P2 (the reveal gate was `req && !local`, fail-open when no request is supplied) was hardened after the verdict in a conductor commit: no request now yields 403 and the lifecycle test passes a local request with a loopback peer. Remaining P3 notes left as follow-ups: strengthen the remote/failure DOM assertions, add lookalike Host rows, drop the clipper alias, and gate the ungated `file://` link in DocumentEditor (pre-existing).

stage: wave-join - ran (cherry-pick of the worker commit onto the target; snapshot refreshed by the conductor; no collision)
stage: impl-review - ran [round 1 SHIP] (model: claude-opus-5 via harness subagent, host backend)
stage: plan-sync - skipped(config: planSync.enabled != true)

2026-09-06 reconciliation: restored completion state from this existing summary and merged PR #206. Gordon confirmed all remaining work was completed and requested spec closure. Earlier BLOCKED/UNMET observations above are historical and superseded by that confirmation.
## Evidence
- Commits: 050dafc0, 8a07db8b, 40750a755cc0a5e6c8d6896319153529a9288a8d, d17ac7d8577c87fbd14a072deef3f39db121edae
- Tests: bun test test/serve/api-capabilities.test.ts test/serve/api-docs-lifecycle.test.ts test/serve/request-locality.test.ts test/serve/public/pages/DocView-actions.dom.test.tsx test/clipper test/serve/security.test.ts -> green (integrated target), bun run lint:check -> clean, bun test test/serve/spa-snapshot-freshness.test.ts -> 2 pass, worker: bun test (full) -> 4479 pass, 1 fail (snapshot freshness, fixed by the conductor rebuild)
- PRs: https://github.com/gmickel/gno/pull/206