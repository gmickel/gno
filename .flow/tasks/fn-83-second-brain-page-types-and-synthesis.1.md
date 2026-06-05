---
satisfies: [R1, R2, R3, R8]
---

## Description

Add the 4 new second-brain presets to the shared core and make them flow through every capture/new-note surface. Refine (don't break) `decision-note`/`source-summary`. Eliminate the MCP enum drift. Keep preset frontmatter FLAT; provenance is NOT authored in presets (the fn-82 capture path already writes the nested `source:` block — leave it untouched). This is the **early proof point** — prove new presets work end-to-end across CLI/REST/SDK/MCP/Web before building the typing layer.

**Size:** M
**Files:** `src/core/note-presets.ts`, `src/mcp/tools/index.ts`, `test/core/note-presets.test.ts`, `test/core/capture.test.ts`, `test/mcp/<presetId-schema>.test.ts` (new — proves MCP accepts new presets); docs: `spec/cli.md` (preset-ID enumeration), `spec/mcp.md`, `docs/CLI.md`, `docs/MCP.md`, `docs/API.md`, `docs/SDK.md`, `CHANGELOG.md`. (Do NOT touch `capture.ts` unless `source.label` genuinely needs it — prefer reusing `title`/`author`.)

## Approach

- Add `idea-original`, `person`, `company-project`, `meeting` to the `NotePresetId` union (`src/core/note-presets.ts:11-17`) and to `NOTE_PRESETS` (`:74-139`).
- Each new preset's `frontmatter` emits flat keys only: `type: "<id>"`, `category: "<id>"`, `tags: []`. Body follows **Current Synthesis → Open Threads → Assessment → `## Timeline`** (per spec). `meeting` puts analysis above, transcript/action items below the `## Timeline` sentinel. No body `---` separators (collides w/ YAML fence / `<hr>`).
- Reuse `serializeFrontmatter()` as-is (`:46-72`); do NOT add nested objects. Do NOT hand-author a `source:` block — provenance is applied by the fn-82 capture path (`sourceFrontmatterLines()`/`mergeCaptureFrontmatter()` in `capture.ts`), which stays unchanged.
- Resolve the `source.label` gap (Decision 3): use existing `CaptureSource` fields (`title`/`author`).
- **Fix MCP enum drift (Decision 5):** replace the hardcoded `presetId: z.enum([...])` at `src/mcp/tools/index.ts:175-185` with a value derived from `NOTE_PRESETS.map(p => p.id)`. Add a `test/mcp` schema-parse test asserting a new preset (e.g. `person`) parses through the `gno_capture` input schema.
- Preserve `decision-note`/`source-summary` IDs (`:74-139`); refine bodies in place only; add a regression test that both still resolve.
- Add repo reference docs for the new preset IDs in the same commit (enumerate IDs in CLI/MCP/API/SDK + `spec/cli.md`+`spec/mcp.md`; CHANGELOG `[Unreleased] → Added`). Add a short prose explainer of the synthesis/timeline pattern + when to use each preset in `docs/CLI.md` (R8 repo portion). **Own only the preset-ID enumeration in `spec/cli.md`** — the `contentTypes` config-shape section is owned by `.2` (avoid edit overlap).

## Investigation targets

**Required:**

- `src/core/note-presets.ts:11-17,46-72,74-139,141-183` — union, serializer, registry, resolve.
- `src/mcp/tools/index.ts:175-185` — the hardcoded enum to derive from `NOTE_PRESETS`.
- `src/core/capture.ts:53-65,499-516` — `CaptureSource`, `sourceFrontmatterLines` (nested writer, leave untouched), `mergeCaptureFrontmatter`.
- `test/core/note-presets.test.ts`, `test/core/capture.test.ts` — mirror existing patterns; locate the `test/mcp` dir for the schema-parse test.

**Optional:**

- `src/serve/routes/api.ts:72-76,1413-1427`, `src/sdk/types.ts:10`, `src/cli/commands/capture.ts:18`, Web `CaptureModal.tsx:25` — confirm they consume core (no per-surface changes expected).

## Acceptance

- [ ] R1: 4 new preset IDs added to `NotePresetId`/`NOTE_PRESETS`; `gno capture --preset <id>` works for each via CLI, REST `/api/capture`+`/api/docs`, SDK `client.capture()`, MCP `gno_capture`, and Web quick capture.
- [ ] R1: MCP presetId enum derived from `NOTE_PRESETS` (no hardcoded list); a `test/mcp` schema-parse test asserts a new preset is accepted via `gno_capture`.
- [ ] R2: `decision-note` and `source-summary` IDs unchanged and still valid (regression test).
- [ ] R3: each new preset emits flat `type:"<id>"`, `category:"<id>"`, `tags: []`, body contains `## Timeline` and no body `---` separator (test-asserted); presets author no `source:` block; provenance path (`capture.ts`) untouched; `source.label` resolved via existing fields.
- [ ] R8 (repo): `docs/CLI.md` explains the synthesis/timeline pattern + when to use each preset; preset IDs enumerated in CLI/MCP/API/SDK docs + `spec/cli.md`/`spec/mcp.md`; CHANGELOG updated.
- [ ] `bun run lint:check && bun test` green.

## Done summary

Added four second-brain note presets with flat frontmatter and synthesis/timeline scaffolds, preserved existing preset IDs, and derived the MCP capture preset enum from the shared preset registry. Updated in-repo docs/spec surfaces and added core/capture/MCP schema regression coverage.

## Evidence

- Commits: 4102d42aa3270631d4e27cd83675c94cbe7bc293
- Tests: bun test test/core/note-presets.test.ts test/core/capture.test.ts test/mcp, bun run lint:check && bun test, isolated CLI smoke: bun src/index.ts capture --preset person --title Jane Doe --folder people --collection notes --json; bun src/index.ts capture --preset meeting --title Weekly sync --folder meetings --collection notes --json
- PRs:
