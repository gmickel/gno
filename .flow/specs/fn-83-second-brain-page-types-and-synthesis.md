# Second-brain page types and synthesis templates

## Goal & Context

Give GNO a lightweight second-brain writing model: pages that distinguish current synthesis from evidence, and configurable type hints that improve search, graph, authoring, and future audits without imposing a heavy ontology.

Inspiration: `garrytan/gbrain` cloned at `/tmp/gbrain`, especially compiled-truth + timeline, schema packs, source attribution, and idea/original capture docs. Use as inspiration only; do not copy code verbatim.

## Architecture & Data Models

Extend the existing note preset system into second-brain templates:

- `idea/original`: exact phrasing, context, related concepts, publish potential.
- `person`: current state, relationship, assessment, open threads, timeline.
- `company/project`: state, what changed, decisions, people, timeline.
- `meeting`: analysis above the separator, transcript/notes/action items below.
- `decision`: context, decision, rationale, consequences, evidence trail.
- `source-summary`: claims, evidence, takeaways, source metadata.

Adopt an explicit page pattern:

```markdown
---
type: person
category: person
tags: []
source: ...
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

1. Frontmatter `type`/`category`.
2. Configured path prefixes.
3. Existing content metadata/category.
4. Fallback to note/document.

## API Contracts

- `GET /api/note-presets` includes second-brain presets and metadata.
- `POST /api/docs`/capture can select presets.
- `gno ls/search/query --category` continues to work with inferred types.
- Future `gno types` or `gno content-types` command can list configured types, but this spec can start by extending config and docs.

## Edge Cases & Constraints

- Existing notes must remain valid; type inference must be additive.
- No migration that rewrites user files automatically.
- Avoid gbrain-style full schema mutation/audit in this phase.
- Keep templates editable and not product-lock users into one note taxonomy.
- Preserve GNO’s collection-oriented model; do not introduce brain/source axes.

## Acceptance Criteria

- [ ] New presets are available in Web UI/API/SDK and can be used by capture/new-note flows.
- [ ] Typed frontmatter is indexed into existing metadata/category filters where applicable.
- [ ] Configurable prefix-to-type inference is documented and tested.
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
