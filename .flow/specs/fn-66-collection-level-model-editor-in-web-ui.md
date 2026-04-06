# fn-66-collection-level-model-editor-in-web-ui Collection-level model editor in web UI

## Overview

Collection-level model overrides shipped in config and runtime under `fn-64`, but the web app still only exposes global preset switching.

This follow-up makes collection-scoped model selection usable without hand-editing `~/.config/gno/index.yml`.

Primary goal:

- let users inspect and edit per-collection model overrides in the web app

Secondary goals:

- show effective model resolution clearly
- show when an override inherits vs replaces the active preset
- make recovery obvious when an override implies download or re-embedding work

This is a UI/editor epic, not a new model system.

## Scope

Included:

- read/write API support for collection-level `models` overrides
- effective-resolution payloads so UI can explain inherited vs overridden roles
- collection-level model editor UX in the web app
- docs/API/website updates for the new UI and operator flow
- recovery guidance when changing an embed override on a populated collection

Excluded:

- path/file-type overrides; covered by `fn-65-granular-model-resolution-for-path-and`
- changing global preset picker behavior
- benchmarking or changing default models
- automatic destructive cleanup of old vectors
- per-folder config files or any config outside central `index.yml`

## Approach

### Prior context

- Collection-scoped model overrides already exist in config/runtime:
  - `src/config/types.ts`
  - `src/llm/registry.ts`
  - `docs/adr/004-collection-model-resolution.md`
- Web UI today only exposes global preset controls:
  - `/api/presets`
  - `src/serve/public/components/FirstRunWizard.tsx`
  - `src/serve/public/pages/Search.tsx`
  - `src/serve/public/pages/Ask.tsx`
- Collections API is too thin for editing:
  - `GET /api/collections` only returns `name` + `path`
  - no collection update endpoint exists today
- Collections page already has the right user home for this work:
  - `src/serve/public/pages/Collections.tsx`

### Reuse anchors

- config schema: `src/config/types.ts:64`
- collection override resolution: `src/llm/registry.ts:100`
- config persistence: `src/config/saver.ts:34`
- existing collection list/create/delete routes:
  - `src/serve/routes/api.ts:630`
  - `src/serve/routes/api.ts:650`
  - `src/serve/routes/api.ts:812`
- current preset routes:
  - `src/serve/routes/api.ts:3168`
  - `src/serve/routes/api.ts:3194`
- existing collection management UI: `src/serve/public/pages/Collections.tsx:1`
- web UI docs:
  - `docs/WEB-UI.md`
  - `docs/API.md`
  - `docs/CONFIGURATION.md`

### Product stance

- collection model editing belongs with collection management, not the global preset picker
- the UI must explain effective models, not just raw override fields
- inherited values should stay visible so users do not have to cross-reference the preset selector manually
- embed override changes on existing collections should surface the likely re-embed consequence explicitly
- do not turn this into a second preset builder

### Deliverables

#### 1. Collection model edit API

- expand collection payloads so the UI can read:
  - collection config fields already in `index.yml`
  - raw `models` overrides
  - effective per-role URIs
  - whether each role is inherited from preset or overridden
- add a collection update route for model overrides
- support clearing one role override without deleting the whole collection
- validate writes through the existing schema/persistence path

#### 2. Web app editor surface

- add a collection-level model editor entry point on the Collections page
- show per-role rows for:
  - `embed`
  - `rerank`
  - `expand`
  - `gen`
- each row should show:
  - active effective URI
  - whether value is inherited or overridden
  - editable override input
  - clear/reset action back to preset inheritance
- if embed changes on a populated collection, show a clear note that semantic results depend on new embeddings being generated

#### 3. Docs and recovery flow

- document the UI path and API payloads
- explain inheritance vs override behavior
- explain the operator flow after changing `embed` on an existing collection
- cross-link to benchmark guidance where relevant

### Risks / traps

- hiding the active preset and making overrides look like standalone presets
- silently accepting empty-string URIs instead of treating them as clear/reset actions
- changing embed overrides without telling users why vector search may look stale or empty until embeddings catch up
- blocking future `fn-65` path/file-type granularity by hard-coding collection-only assumptions into the UI shape

### Task breakdown

#### Task 1

`fn-66-collection-level-model-editor-in-web-ui.1`

Add collection model override read/write API and effective-resolution payloads.

#### Task 2

`fn-66-collection-level-model-editor-in-web-ui.2`

Build collection-level model editor UX in the web app.

#### Task 3

`fn-66-collection-level-model-editor-in-web-ui.3`

Document collection model editing and recovery flows.

## Quick commands

- `bun run lint:check`
- `bun test`
- `bun run docs:verify`
- `bun run website:sync-docs`

## Acceptance

- [ ] The web app can read and persist collection-level model overrides without hand-editing YAML.
- [ ] Users can see effective per-role model URIs and whether each value is inherited or overridden.
- [ ] Clearing an override returns the role to preset inheritance cleanly.
- [ ] The UI warns clearly when changing an embed override implies re-embedding work for an existing collection.
- [ ] API, Web UI docs, configuration docs, and website copy stay in sync.

## References

- `src/config/types.ts`
- `src/llm/registry.ts`
- `src/config/saver.ts`
- `src/serve/routes/api.ts`
- `src/serve/public/pages/Collections.tsx`
- `docs/CONFIGURATION.md`
- `docs/WEB-UI.md`
- `docs/API.md`
- `docs/adr/004-collection-model-resolution.md`
- `.flow/specs/fn-65-granular-model-resolution-for-path-and.md`
