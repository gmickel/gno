# fn-66-collection-level-model-editor-in-web-ui.1 Add collection model override read/write API and effective-resolution payloads

## Description
Add the backend/API surface needed for a real collection-level model editor.

Start here:

- `src/serve/routes/api.ts`
- `src/config/types.ts`
- `src/config/saver.ts`
- `src/llm/registry.ts`
- `docs/API.md`

Requirements:

- expand collection read payloads beyond `name` + `path`
- expose raw collection `models` overrides
- expose effective per-role model resolution for UI display
- expose source of each effective role:
  - `override`
  - `preset`
  - built-in fallback if that still occurs
- add a write path for collection `models` overrides
- support clearing one role override without deleting unrelated roles
- keep config validation and persistence on the existing schema/atomic-write path

Recommended payload shape to evaluate:

- `collection.models`: raw overrides from config
- `collection.effectiveModels`: resolved URIs by role
- `collection.modelSources`: inheritance source by role
- optional `collection.activePresetId` if it simplifies the UI

Recommended write path:

- a targeted update route under `/api/collections/:name`
- do not invent a second config endpoint just for models if a collection update route can stay clean

Tests:

- API route coverage for read/write success
- validation coverage for invalid role URIs / invalid body shapes
- clearing one override preserves siblings
- unspecified roles continue to inherit from active preset
- existing collections without `models` blocks still serialize cleanly

Docs owned by this task if the payload/API changes:

- `docs/API.md`
- `spec/cli.md` only if any CLI surface changes, otherwise no-op
- `docs/CONFIGURATION.md` if wire format examples need adjustment

## Acceptance
- [ ] Collections API exposes raw overrides plus effective per-role model resolution for UI use.
- [ ] A write path exists for setting and clearing collection model overrides.
- [ ] Clearing one override does not clobber other roles.
- [ ] Validation/persistence reuse the existing config schema and atomic-save path.
- [ ] API docs reflect the final request/response shape.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
