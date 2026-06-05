# Second-brain page types and synthesis templates

## Goal & Context

Give GNO a lightweight second-brain writing model on top of the shipped `fn-82` capture/provenance foundation: pages that distinguish current synthesis from evidence, and type hints that improve search, graph, authoring, and future audits without imposing a heavy ontology.

Inspiration: `garrytan/gbrain` cloned at `/tmp/gbrain`, especially compiled-truth + timeline, schema packs, source attribution, and idea/original capture docs. Use as inspiration only; do not copy code verbatim.

`fn-82` dependency status: complete. Capture now has one shared provenance contract across CLI, REST, SDK, MCP, and Web UI. This spec must extend that contract instead of adding parallel capture, source, or receipt concepts.

## Architecture & Data Models

Extend the existing note preset system into second-brain templates. `NotePresetId` is currently a TypeScript union in `src/core/note-presets.ts`; any new preset ID must be added to that shared core and then flow through CLI/API/SDK/MCP/Web capture validation.

- `idea-original`: exact phrasing, context, related concepts, publish potential.
- `person`: current state, relationship, assessment, open threads, timeline.
- `company-project`: state, what changed, decisions, people, timeline.
- `meeting`: analysis above the separator, transcript/notes/action items below.
- Existing `decision-note`: refine as needed, but do not break the current preset ID without an explicit alias/deprecation path.
- Existing `source-summary`: refine as needed, but reuse the current preset ID and `fn-82` source frontmatter shape.

Adopt an explicit page pattern:

```markdown
---
type: person
category: person
tags: []
source:
  kind: direct
  label: "..."
  uri: "..."
---

# Title

## Current Synthesis

## Open Threads

## Assessment

---

## Timeline

- YYYY-MM-DD | Evidence item. [Source: ...]
```

Add a schema-lite configuration, not a full mutable ontology:

```yaml
contentTypes:
  - id: person
    prefixes: ["people/", "contacts/"]
    preset: person
    graphHints: [mentions, works_at, attended]
    searchBoost: 1.15
  - id: meeting
    prefixes: ["meetings/"]
    preset: meeting
    temporal: true
```

Type inference priority:

1. Frontmatter `type` when valid.
2. Configured path prefixes.
3. Frontmatter `category`/`categories` as category filters.
4. Existing path/extension metadata.
5. Fallback to `prose`/`note`.

Current code note: `src/ingestion/sync.ts` currently sets `contentType` from path/extension heuristics and only adds frontmatter `type`/`category`/`categories` to categories. Implementing this spec requires an explicit ingestion change if frontmatter `type` is meant to become the canonical `contentType`.

`contentTypes` does not exist in `src/config/types.ts` yet. The plan should either add config schema/docs/tests for `contentTypes` or deliberately defer configurable types and ship only built-in presets first.

## API Contracts

- `GET /api/note-presets` includes second-brain presets and metadata from the shared preset core.
- `POST /api/docs` and all capture surfaces accept the same preset IDs: CLI `gno capture`, REST `/api/capture`, SDK `client.capture()`, MCP `gno_capture`, and Web UI quick capture.
- Capture receipts remain the `fn-82` receipts; no new receipt schema.
- `gno ls/search/query --category` continues to work with typed pages.
- If canonical `contentType` becomes user-configurable, search/query result shapes must expose `contentType` and `categories` consistently with existing schema contracts.
- Future `gno types` or `gno content-types` command can list configured types, but this spec can start by extending config and docs.

## Edge Cases & Constraints

- Existing notes must remain valid; type inference must be additive.
- No migration that rewrites user files automatically.
- Avoid gbrain-style full schema mutation/audit in this phase.
- Keep templates editable and not product-lock users into one note taxonomy.
- Preserve GNO’s collection-oriented model; do not introduce brain/source axes.
- Do not duplicate provenance. Reuse `fn-82` `CaptureSource` and frontmatter serialization behavior for template source blocks.
- Avoid breaking current `decision-note` and `source-summary` preset IDs. Add aliases only if the plan includes compatibility tests and docs.

## Acceptance Criteria

- [ ] New preset IDs are added to shared preset core and accepted by CLI/API/SDK/MCP/Web capture and new-note flows.
- [ ] Existing `decision-note` and `source-summary` remain valid, or deliberate aliases are documented and tested.
- [ ] Template source blocks reuse the `fn-82` provenance/source shape.
- [ ] Typed frontmatter is indexed into existing metadata/category filters where applicable.
- [ ] If frontmatter `type` should control canonical `contentType`, ingestion implements that priority and tests distinguish `contentType` from category filters.
- [ ] If `contentTypes` config ships in this spec, configurable prefix-to-type inference is documented and tested; if deferred, the spec plan states that explicitly.
- [ ] Search/query results expose content type/category consistently.
- [ ] Docs explain the compiled-synthesis/timeline pattern and when to use it.
- [ ] Hosted `gno.sh` docs and agent skill docs are synced.

## Documentation Requirement

Every implementation task from this spec must update all relevant GNO documentation surfaces in the same change set: repo docs/specs, CLI/MCP/API references, skill assets where applicable, and the hosted website repo at `/Users/gordon/work/gno.sh`. Do not mark the spec or a user-facing task complete while hosted website docs remain stale.

## Boundaries

- No autonomous page rewriting.
- No external enrichment.
- No multi-user schema authoring.
- No hard requirement that users adopt the templates.

## Decision Context

GNO has note creation and presets already. This spec upgrades those primitives into a durable second-brain structure while staying local-first and markdown-native.
