---
satisfies: [R6]
---

## Description

Add an opt-in, schema-lite `contentTypes` config key (NOT a mutable ontology) with **post-parse** closed-graph validation. Because `loadConfigFromPath` hard-fails on Zod errors and has **no warning channel** (success is `{ ok: true; value }`), this task must (a) keep the schema permissive and (b) **introduce a warnings transport** so invalid entries warn-and-drop instead of crashing. Empty config == today's behavior. This is the declarative source the ingestion inference (`.3`) reads. `searchBoost`/`graphHints` are accepted but reserved/no-op this phase. Depends on `.1` (presets must exist so the `preset` ref + tests resolve; avoids concurrent `spec/cli.md` edits).

**Size:** M
**Files:** `src/config/types.ts`, `src/config/loader.ts` (extend result type + call the normalizer), a reusable normalizer module (`src/config/content-types.ts` or similar), config-load callers that consume the result (CLI/serve/MCP load sites — surface warnings), `test/config/<new>.test.ts`, `docs/CONFIGURATION.md`, `spec/cli.md` (config-shape section only).

## Approach

- Add `ContentTypeSchema` (Zod) with `id`, `prefixes: string[]`, `preset: string`, `graphHints?: string[]`, `searchBoost?: number`, `temporal?: boolean`. Mirror `ModelPresetSchema`/`DEFAULT_MODEL_PRESETS` at `src/config/types.ts:171-229`. Keep `preset` a **plain string** (no `.refine()` cross-check — that hard-fails).
- Add `contentTypes: z.array(ContentTypeSchema).default([])` to `ConfigSchema` (`:252-270`). Default `[]` so a binary upgrade alone changes nothing.
- **Add a warnings transport (the load result has none today):** extend the `loadConfigFromPath` success result from `{ ok: true; value }` to `{ ok: true; value; warnings: ConfigWarning[] }` (`src/config/loader.ts:18-19,131`). Update the load-result callers to surface warnings (don't throw). Keep `{ ok: false; error }` for genuine parse failures.
- **Reusable exported normalizer (not loader-only):** implement `normalizeContentTypes(contentTypes): { rules; warnings }` as a standalone exported function so it works for paths that bypass `loadConfigFromPath` — SDK inline `Config`, serve/runtime in-memory config, and the config-change/mutation path all call it before sync. `loadConfigFromPath` calls it and threads `warnings` into its result.
- **Closed-graph normalization (warn-don't-crash), inside the normalizer:** drop/disable entries whose `preset` doesn't resolve to a real `NotePresetId` (emit a warning); **dedupe exact-duplicate prefixes only** — retain genuinely overlapping prefixes (`people/` vs `people/team/`) and sort longest-prefix-wins. The returned `rules` are the normalized, ordered set `.3` consumes.
- **Reserved fields:** document `searchBoost` (future ranking) and `graphHints` (fn-84 typed graph) as accepted-but-no-op in fn-83. Keep `graphHints` vocabulary documented/centralized so fn-84 reuses it.
- Check whether the config `version` literal needs a bump (additive default usually does not).
- Document `contentTypes` in `docs/CONFIGURATION.md` (new section, `person`/`meeting` examples, mark reserved fields) + add the key to the config-shape section of `spec/cli.md` (`.1` owns preset-ID enumeration), same commit.

## Investigation targets

**Required:**

- `src/config/types.ts:171-229` (ModelPreset pattern), `:252-270` (ConfigSchema slot).
- `src/config/loader.ts:18-19,51-131` — result type + `loadConfigFromPath`; where the warnings field + post-parse normalization land.
- `src/core/note-presets.ts:11-21` — `NotePresetId` for post-parse `preset` resolution. <!-- Updated by plan-sync: fn-83-second-brain-page-types-and-synthesis.1 used expanded NotePresetId union range 11-21 not planned 11-17 -->

**Optional:**

- Config-load call sites (CLI/serve/MCP) that must surface the new warnings.
- fn-68 spec/tasks — overlapping `config/types.ts` edits; keep extension points additive.

## Acceptance

- [ ] R6: `contentTypes` array added to `ConfigSchema` with `default([])`; Zod validates `id`/`prefixes`/`preset`/`graphHints`/`searchBoost`/`temporal` with `preset` as a permissive string.
- [ ] R6: `loadConfigFromPath` success result extended to carry `warnings: ConfigWarning[]`; callers surface them; `{ ok: false; error }` retained for real parse failures.
- [ ] R6: exported `normalizeContentTypes()` warns (not crash) on unknown `preset` ref and drops/disables that entry; **exact-duplicate** prefixes deduped while overlapping prefixes are retained and sorted longest-prefix-wins; returns `{ rules; warnings }`. `loadConfigFromPath` AND inline SDK/serve/config-change paths call it (none receive raw `contentTypes`).
- [ ] R6: empty/absent `contentTypes` == legacy behavior (test asserts no change); an invalid `preset` ref yields a warning + dropped entry, not a load failure.
- [ ] R6: `searchBoost`/`graphHints` documented as reserved/no-op this phase.
- [ ] R6: `docs/CONFIGURATION.md` + `spec/cli.md` (config-shape) document the key with examples; config test added.
- [ ] `bun run lint:check && bun test` green.

## Done summary

## Evidence
