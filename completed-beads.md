# Completed Beads Archive

Historical record of completed issues from the beads (bd) tracking system.
These issues were migrated to Flow-Next on 2026-01-09.

---

## [gno-ggs] Fix Windows CI build failures

**Type:** epic | **Priority:** P1 | **Status:** closed  
**Created:** 2026-01-06 | **Closed:** 2026-01-06

**Close reason:** Windows CI fixed - safeRm, path separators, hook timeouts

~87 tests fail on Windows with EBUSY errors during cleanup. Root cause: test files use raw rm() instead of safeRm() from test/helpers/cleanup.ts. Additional issues: symlink test references /etc (Unix-only), D:/Temp CI workaround may break on Windows Server 2025.

---

## [gno-ggs.4] Verify Windows CI passes end-to-end

**Type:** task | **Priority:** P1 | **Status:** closed  
**Created:** 2026-01-06 | **Closed:** 2026-01-06

**Close reason:** Windows CI passes - all 1315 tests green

After fixes applied, verify Windows CI passes.

Steps:

1. Push changes to branch
2. Monitor CI Windows job
3. All 87+ tests should pass
4. No EBUSY errors in logs

Acceptance:

- Windows CI job passes (green)
- No file lock errors in test output

---

## [gno-ggs.2] Fix validation.test.ts symlink test for Windows

**Type:** task | **Priority:** P1 | **Status:** closed  
**Created:** 2026-01-06 | **Closed:** 2026-01-06

**Close reason:** Closed

test/core/validation.test.ts L55-65 creates symlink to /etc which doesn't exist on Windows.

Options:

- Skip test on Windows (process.platform check)
- Use Windows-appropriate path (C:\Windows\System32)
- Use relative symlink within temp dir

Recommendation: Skip on Windows with process.platform !== 'win32'

Also check: validateRelPath tests may fail due to backslash paths on Windows.

---

## [gno-ggs.1] Replace raw rm() with safeRm() in test files

**Type:** task | **Priority:** P1 | **Status:** closed  
**Created:** 2026-01-06 | **Closed:** 2026-01-06

**Close reason:** Closed

12 test files use raw rm() in afterEach cleanup, causing EBUSY on Windows. Replace with safeRm() from test/helpers/cleanup.ts.

Files:

- test/store/links.test.ts (L51)
- test/store/tags.test.ts (L51)
- test/serve/api-collections.test.ts (L152, L217)
- test/serve/api-links.test.ts (L48)
- test/serve/api-docs-update.test.ts (L64)
- test/serve/api-tags.test.ts (L52)
- test/ingestion/sync-links.test.ts (L48, L467)
- test/ingestion/sync-tags.test.ts (L48, L216)
- test/core/validation.test.ts (L21)
- test/core/file-ops.test.ts (L19)
- test/llm/lockfile.test.ts (L25)

Acceptance:

- All rm() calls in afterEach/afterAll replaced with safeRm()
- Import { safeRm } from '../helpers/cleanup' added
- Tests pass locally on macOS/Linux

---

## [gno-65x.4] Fix gno-65x review issues

**Type:** task | **Priority:** P1 | **Status:** closed  
**Created:** 2026-01-05 | **Closed:** 2026-01-05

**Close reason:** done

Address review issues: resolveLinks optional .md + basename; getGraph basename matches; fix SQL error; add tests; ensure docs align. See review list.

---

## [gno-65x.2] Tests: wiki path links

**Type:** task | **Priority:** P1 | **Status:** closed  
**Created:** 2026-01-05 | **Closed:** 2026-01-05

**Close reason:** done

Add store + sync tests for Obsidian-style wiki paths (absolute/relative, basename, .md). refs: test/store/links.test.ts, test/ingestion/sync-links.test.ts

---

## [gno-65x.1] Wiki path resolution fallback

**Type:** task | **Priority:** P1 | **Status:** closed  
**Created:** 2026-01-05 | **Closed:** 2026-01-05

**Close reason:** done

Add extractWikiBasename helper; extend resolveLinks/getBacklinksForDoc/getGraph wiki matching w/ pathlike fallbacks, deterministic order, no reindex. refs: src/core/links.ts, src/store/sqlite/adapter.ts

---

## [gno-ku5] similar command: vec0 index not synced after embed

**Type:** bug | **Priority:** P1 | **Status:** closed  
**Created:** 2026-01-05 | **Closed:** 2026-01-05

**Close reason:** fixed: vec0 auto-sync, vec CLI commands, transaction wrap

The similar command returns no results even when documents have high cosine similarity (0.79 verified manually).

## Root cause

upsertVectors in sqlite-vec.ts silently catches vec0 insert errors (lines 176-179). syncVecIndex/rebuildVecIndex exist but are never called.

## Repro

1. Add collection with short docs
2. gno sync && gno index
3. gno similar test/note-a.md --threshold 0.0
4. Returns empty even though docs have 0.79 cosine similarity

## Fix approach (from rp-cli review)

### 1. Stop swallowing vec0 errors

In sqlite-vec.ts upsertVectors:

- Log warning on vec0 failure (rate-limited, once per run)
- Set `vecDirty = true` flag on VectorIndexPort

### 2. Sync once per run, only if dirty

In embedBacklog() (src/embed/index.ts):

- After all batches complete, check vecDirty
- If dirty, call syncVecIndex() once
- Don't sync per-batch (too expensive)

### 3. Add manual recovery CLI

New commands under `gno vec`:

- `gno vec sync` - incremental sync (add missing, remove orphans)
- `gno vec rebuild` - drop + recreate + repopulate
- Infer dimensions from content_vectors.embedding.byteLength / 4

### 4. Future optimization (not required now)

Add targeted `syncVecIndexForMirror(mirrorHash)` for efficient incremental updates using known chunk IDs instead of global NOT IN queries.

## Failure modes to handle

- **Dimension mismatch**: vec table created with wrong FLOAT[n] - rebuild fixes
- **Schema invalidation**: DROP/recreate invalidates prepared statements - rebuild fixes
- **Logical divergence**: content_vectors has data, vec0 doesn't - sync fixes

## Files

- src/store/vector/sqlite-vec.ts - error handling, vecDirty flag, export flag
- src/embed/index.ts - call sync after embedBacklog if dirty
- src/cli/program.ts - add `gno vec` subcommand group

## No UI work

RelatedNotesSidebar already uses /api/doc/:id/similar endpoint.

---

## [gno-2iw.5] Phase 6: Documentation & Website

**Type:** task | **Priority:** P1 | **Status:** closed  
**Created:** 2026-01-04 | **Closed:** 2026-01-05

**Close reason:** All documentation updated: docs, spec, website bento card, pSEO page

Documentation and specification updates for the note linking feature.

## Documentation Files to Update (docs/)

### CRITICAL Priority

#### 1. docs/CLI.md

**Additions:**

- New section "## Link Commands" after Document Commands
- `gno links <doc>` - List outgoing links from a document
- `gno backlinks <doc>` - List documents that link TO this document
- `gno similar <doc>` - Find semantically similar documents
- Update Quick Reference table with 3 new commands
- Examples with all output formats (--json, --md)

#### 2. docs/API.md

**Additions:**

- New section "## Link Endpoints"
- `GET /api/doc/:id/links` - Get outgoing links
- `GET /api/doc/:id/backlinks` - Get backlinks
- `GET /api/doc/:id/similar` - Get similar documents
- `GET /api/docs/suggest` - Autocomplete endpoint for wiki links
- Update Quick Reference table
- Request/response examples with curl
- Python and JavaScript usage examples

#### 3. docs/MCP.md

**Additions:**

- New section "## Link Tools"
- `gno_links` - Get outgoing links from document
- `gno_backlinks` - Get documents linking to a document
- `gno_similar` - Get similar/related documents
- Update Available Tools table
- Example prompts for Claude Desktop
- Use cases in AI workflows

### HIGH Priority

#### 4. docs/WEB-UI.md

**Additions:**

- New section "## Document Sidebar"
  - Backlinks panel description
  - Outgoing links panel description (with broken link indicator)
  - Related notes panel description
- New section "## Wiki Link Autocomplete"
  - Trigger behavior (`[[`)
  - Cross-collection suggestions with prefix
  - Keyboard navigation (arrows, Enter, Escape)
- Update Keyboard Shortcuts section
- Add to Features overview

### MEDIUM Priority

#### 5. docs/QUICKSTART.md

**Additions:**

- Add "## Exploring Links" section with examples:
  ```bash
  gno backlinks my-note.md
  gno links my-note.md
  gno similar my-note.md
  ```
- Mention wiki link syntax `[[link]]` in indexing section

#### 6. docs/ARCHITECTURE.md

**Additions:**

- New section "## Link System"
  - Schema explanation (doc_links table)
  - Link types: wiki vs markdown
  - Resolution at query time (not stored target_doc_id)
  - Position tracking (1-based line/col)
- Update Storage section with doc_links table
- Update Pipeline diagram if needed

#### 7. docs/GLOSSARY.md

**New terms to add:**

- **Wiki Link** - `[[document-name]]` syntax for internal links
- **Backlink** - Documents that link TO a given document
- **Outgoing Link** - Links FROM a document to other documents
- **Similar Documents** - Semantically related docs via vector search
- **Link Resolution** - Process of matching link targets to documents
- **Cross-collection Link** - `[[collection:Note]]` syntax

### LOW Priority

#### 8. docs/HOW-SEARCH-WORKS.md

**Minor additions:**

- Note about link-based ranking (if applicable)
- Link to ARCHITECTURE.md for link system details

#### 9. docs/USE-CASES.md

**New section:**

- "## Networked Notes (Zettelkasten/Obsidian-style)"
- Example of using backlinks for knowledge graph navigation
- Example AI queries: "Show all notes linking to my auth architecture decision"

## Specification Files to Update (spec/)

### CRITICAL Priority

#### 1. spec/cli.md

**Additions:**

- Full command specifications for:
  - `gno links <doc>` with all options (--limit, --json, --md, --context)
  - `gno backlinks <doc>` with all options
  - `gno similar <doc>` with all options
- Exit codes for link commands
- Update Output Format Support Matrix table
- Add to Global Flags if any link-specific flags

#### 2. spec/mcp.md

**Additions:**

- Full tool specifications for:
  - `gno_links` with input/output schemas
  - `gno_backlinks` with input/output schemas
  - `gno_similar` with input/output schemas
- Update Tools section
- Add security considerations (read-only tools)

### HIGH Priority

#### 3. spec/output-schemas/ - New Schema Files

**Create:**

- `links-response.schema.json` - Response for gno links command/tool
- `backlinks-response.schema.json` - Response for gno backlinks command/tool
- `similar-response.schema.json` - Response for gno similar command/tool
- `doc-suggest-response.schema.json` - Response for autocomplete endpoint

#### 4. spec/db/schema.sql

**Additions:**

- Document the doc_links table schema
- Include indexes and constraints
- Add comments explaining design decisions

### MEDIUM Priority

#### 5. test/spec/schemas/ - Contract Tests

**Create:**

- `links.schema.test.ts` - Validate links responses match schema
- `backlinks.schema.test.ts` - Validate backlinks responses match schema
- `similar.schema.test.ts` - Validate similar responses match schema

## Website Updates

### website/\_layouts/home.html (CRITICAL)

**Add feature card to homepage bento grid:**
The homepage features grid (lines ~100-243) contains hardcoded feature cards. Add new card for Note Linking:

```html
<a href="{{ '/features/note-linking/' | relative_url }}" class="feature-card">
  <div class="feature-card-icon">
    {% include icons.html icon="link" size="24" %}
  </div>
  <h3 class="feature-card-title">Note Linking</h3>
  <p class="feature-card-description">
    Wiki links, backlinks, and semantic similarity. Navigate your knowledge
    graph.
  </p>
</a>
```

Position: After "Tag System" card, before "Web UI" card

### website/\_data/features.yml

**Add feature definition for pSEO page:**

```yaml
- title: Note Linking
  description: Wiki links, backlinks, and semantic similarity
  icon: link
  details:
    - "[[Wiki links]] and [Markdown](links)"
    - Cross-collection linking
    - Backlink discovery
    - Semantic similar notes
```

### website/features/note-linking.md (NEW)

**Create pSEO feature page:**

- Overview of note linking feature
- Wiki link syntax examples
- Backlinks use cases (Zettelkasten, PKM)
- Similar docs for discovery
- Cross-collection linking
- Integration examples (CLI, API, MCP)

### website/docs/ (auto-synced)

- Run `bun run website:sync-docs` after docs/ updates
- CHANGELOG.md copied automatically

## Verification Checklist

After all updates, verify:

- [ ] `bun run docs-verify` passes (docs match implementation)
- [ ] `bun run website:sync-docs` successful
- [ ] All new schemas validate with JSON Schema Draft 2020-12
- [ ] Contract tests in test/spec/schemas/ pass
- [ ] No broken internal links in documentation
- [ ] Examples are accurate and runnable
- [ ] CLI help text matches docs
- [ ] Homepage bento includes Note Linking card
- [ ] pSEO feature page /features/note-linking/ renders correctly

## Test Coverage

### test/docs/links-docs.test.ts

- [ ] CLI.md documents all link commands
- [ ] API.md documents all link endpoints
- [ ] MCP.md documents all link tools
- [ ] WEB-UI.md documents sidebar and autocomplete
- [ ] ARCHITECTURE.md explains link system
- [ ] QUICKSTART.md has link usage examples

### test/spec/schemas/links.schema.test.ts

- [ ] links-response.schema.json is valid JSON Schema
- [ ] CLI links --json output matches schema
- [ ] API /api/doc/:id/links response matches schema

### test/spec/schemas/backlinks.schema.test.ts

- [ ] backlinks-response.schema.json is valid JSON Schema
- [ ] CLI backlinks --json output matches schema
- [ ] API /api/doc/:id/backlinks response matches schema

### test/spec/schemas/similar.schema.test.ts

- [ ] similar-response.schema.json is valid JSON Schema
- [ ] CLI similar --json output matches schema
- [ ] API /api/doc/:id/similar response matches schema

## Acceptance Criteria

- [ ] All 9 docs files updated with link feature info
- [ ] spec/cli.md has full link command specs
- [ ] spec/mcp.md has full link tool specs
- [ ] 4 new output schemas created
- [ ] spec/db/schema.sql documents doc_links table
- [ ] Contract tests for all new schemas
- [ ] Homepage bento (home.html) includes Note Linking card
- [ ] website/\_data/features.yml includes link feature
- [ ] pSEO page website/features/note-linking.md created
- [ ] `bun run website:sync-docs` successful
- [ ] No broken internal links in docs
- [ ] All examples accurate and runnable

---

## [gno-2iw.4] Phase 5: WebUI Components

**Type:** task | **Priority:** P1 | **Status:** closed  
**Created:** 2026-01-04 | **Closed:** 2026-01-05

**Close reason:** Duplicate of gno-4ms

WebUI components for link management (React + TypeScript).

## IMPORTANT: Use Frontend Design Plugin

**For ALL UI component work in this phase, use the frontend-design plugin:**

```
/frontend-design:frontend-design <description of component>
```

This ensures distinctive, high-quality designs matching the "Scholarly Dusk" aesthetic.

## Components

### Right Sidebar

Collapsible sidebar on document view with multiple panels.

**Location:** `src/serve/public/components/DocSidebar.tsx`

```tsx
interface DocSidebarProps {
  docId: number;
  docUri: string;
}

export function DocSidebar({ docId, docUri }: DocSidebarProps) {
  return (
    <aside className="doc-sidebar">
      <BacklinksPanel docId={docId} />
      <OutgoingLinksPanel docId={docId} />
      <SimilarDocsPanel docId={docId} docUri={docUri} />
    </aside>
  );
}
```

### BacklinksPanel

Shows documents that link TO this document.

**Location:** `src/serve/public/components/BacklinksPanel.tsx`

**Use `/frontend-design:frontend-design` for:**

- Collapsible panel header with count badge
- Backlink item with source doc title + link text
- Empty state design
- Loading skeleton

**Features:**

- Collapsible with "Backlinks (N)" header
- Show source doc title + link text
- Click navigates to source doc
- Empty state: "No backlinks"

### OutgoingLinksPanel

Shows links FROM this document.

**Location:** `src/serve/public/components/OutgoingLinksPanel.tsx`

**Use `/frontend-design:frontend-design` for:**

- Link item with type icon (wiki/markdown)
- Broken link indicator (subtle warning)
- Panel layout matching BacklinksPanel

**Features:**

- Collapsible with "Links (N)" header
- Show target + display text + type icon (wiki/md)
- Broken links: subtle indicator (muted text, ⚠ icon)
- Click navigates to target (if resolved)

### SimilarDocsPanel

Shows semantically similar documents.

**Location:** `src/serve/public/components/SimilarDocsPanel.tsx`

**Use `/frontend-design:frontend-design` for:**

- Similarity score badge design
- Related notes item layout
- Loading/refresh indicator

**Features:**

- Collapsible with "Related Notes (N)" header
- Show doc title + similarity score badge
- Background refresh: show cached, refresh on mount
- Empty state: "No related notes"

### WikiLinkAutocomplete

Autocomplete for [[wiki links in editor.

**Location:** `src/serve/public/components/WikiLinkAutocomplete.tsx`

**Use `/frontend-design:frontend-design` for:**

- Floating dropdown positioning
- Suggestion item with collection prefix
- Keyboard focus states
- Match highlighting

**Features:**

- Trigger: after typing `[[`
- Position: floating below cursor
- Show all collections with prefix for cross-collection
- Same collection docs first, then others prefixed with `collection:`
- Keyboard navigation: up/down/enter/escape
- Insert: `[[DocTitle]]` or `[[collection:DocTitle]]`

## Hooks

### useBacklinks

```typescript
// src/serve/public/hooks/useBacklinks.ts
export function useBacklinks(docId: number) {
  return useQuery({
    queryKey: ["backlinks", docId],
    queryFn: () => fetch(`/api/doc/${docId}/backlinks`).then((r) => r.json()),
  });
}
```

### useLinks

```typescript
// src/serve/public/hooks/useLinks.ts
export function useLinks(docId: number) {
  return useQuery({
    queryKey: ["links", docId],
    queryFn: () => fetch(`/api/doc/${docId}/links`).then((r) => r.json()),
  });
}
```

### useSimilar

```typescript
// src/serve/public/hooks/useSimilar.ts
export function useSimilar(docId: number, docUri: string) {
  return useQuery({
    queryKey: ["similar", docId],
    queryFn: () => fetch(`/api/doc/${docId}/similar`).then((r) => r.json()),
    staleTime: 60_000, // Cache for 1 min
    refetchOnMount: "always", // Background refresh
  });
}
```

### useDocSuggestions

```typescript
// src/serve/public/hooks/useDocSuggestions.ts
export function useDocSuggestions(query: string, currentCollection?: string) {
  return useQuery({
    queryKey: ["doc-suggestions", query],
    queryFn: () => fetch(`/api/docs/suggest?q=${query}`).then((r) => r.json()),
    enabled: query.length >= 0, // Trigger on [[
  });
}
```

## New API Endpoint

### GET /api/docs/suggest

Autocomplete endpoint for wiki links.

**Query Parameters:**

- `q` - Search query (partial title match)
- `collection` - Current collection (for prioritization)
- `limit` - Max results (default: 10)

**Response:**

```json
{
  "suggestions": [
    {
      "uri": "gno://coll/note.md",
      "title": "Note Title",
      "collection": "coll"
    },
    { "uri": "gno://work/other.md", "title": "Other Doc", "collection": "work" }
  ]
}
```

## Styling

Use existing Tailwind classes. For custom component styles, use `/frontend-design:frontend-design` to get proper design tokens.

## Test Coverage

### test/serve/components/BacklinksPanel.test.tsx

- [ ] Renders loading state
- [ ] Renders backlinks list
- [ ] Renders empty state
- [ ] Click navigates to source doc
- [ ] Collapsible toggle works

### test/serve/components/OutgoingLinksPanel.test.tsx

- [ ] Renders links list
- [ ] Shows broken link indicator
- [ ] Click navigates to resolved target
- [ ] Broken links not clickable

### test/serve/components/SimilarDocsPanel.test.tsx

- [ ] Renders similar docs
- [ ] Shows similarity score
- [ ] Background refresh triggers
- [ ] Empty state when no similar

### test/serve/components/WikiLinkAutocomplete.test.tsx

- [ ] Shows suggestions after [[
- [ ] Filters by query
- [ ] Shows collection prefix for cross-collection
- [ ] Keyboard navigation works
- [ ] Escape closes dropdown
- [ ] Enter selects suggestion

## Acceptance Criteria

- [ ] All components designed via frontend-design plugin
- [ ] DocSidebar with 3 collapsible panels
- [ ] BacklinksPanel shows incoming links
- [ ] OutgoingLinksPanel shows links with broken indicators
- [ ] SimilarDocsPanel with background refresh
- [ ] WikiLinkAutocomplete triggered by [[
- [ ] Cross-collection suggestions with prefix
- [ ] All component tests pass
- [ ] Responsive design (sidebar collapsible on mobile)
- [ ] Keyboard accessible

---

## [gno-2iw.3] Phase 4: MCP Tools & Resources

**Type:** task | **Priority:** P1 | **Status:** closed  
**Created:** 2026-01-04 | **Closed:** 2026-01-05

**Close reason:** Implemented: CLI/REST/MCP link tools complete, all tests pass

MCP tools and resources for link management (mirrors existing tool patterns).

## Tools

### gno_links

Get outgoing links from a document.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "uri": {
      "type": "string",
      "description": "Document URI (gno://collection/path)"
    },
    "limit": {
      "type": "number",
      "description": "Max results (default: 20)"
    }
  },
  "required": ["uri"]
}
```

**Output:**

```json
{
  "doc": { "uri": "gno://coll/note.md", "title": "My Note" },
  "links": [
    {
      "type": "wiki",
      "target": "Related",
      "displayText": null,
      "resolved": true,
      "targetUri": "gno://coll/related.md"
    },
    {
      "type": "markdown",
      "target": "./other.md",
      "displayText": "Link",
      "resolved": false,
      "targetUri": null
    }
  ],
  "meta": { "total": 2, "broken": 1 }
}
```

### gno_backlinks

Get documents that link TO a document.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "uri": {
      "type": "string",
      "description": "Document URI"
    },
    "limit": {
      "type": "number",
      "description": "Max results (default: 20)"
    },
    "context": {
      "type": "boolean",
      "description": "Include surrounding text (default: false)"
    }
  },
  "required": ["uri"]
}
```

**Output:**

```json
{
  "doc": { "uri": "gno://coll/note.md", "title": "My Note" },
  "backlinks": [
    {
      "sourceUri": "gno://coll/other.md",
      "sourceTitle": "Other",
      "linkText": "see My Note",
      "context": "...context..."
    }
  ],
  "meta": { "total": 1 }
}
```

### gno_similar

Get semantically similar documents.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "uri": {
      "type": "string",
      "description": "Document URI"
    },
    "limit": {
      "type": "number",
      "description": "Max results (default: 5)"
    }
  },
  "required": ["uri"]
}
```

**Output:**

```json
{
  "doc": { "uri": "gno://coll/note.md", "title": "My Note" },
  "similar": [
    { "uri": "gno://coll/related.md", "title": "Related Topic", "score": 0.92 }
  ],
  "meta": { "total": 1 }
}
```

## Resources

### gno://doc/:id/links

Read-only resource exposing document links.

**URI Template:** `gno://doc/{docId}/links`

**Response:** Same as gno_links output

**Usage:**

```typescript
// Client reads resource
const links = await client.readResource("gno://doc/123/links");
```

## Implementation

### src/mcp/tools/links.ts

```typescript
export const gnoLinksToolDef: ToolDefinition = { ... };
export async function handleGnoLinks(args: GnoLinksArgs): Promise<ToolResponse>;
```

### src/mcp/tools/backlinks.ts

```typescript
export const gnoBacklinksToolDef: ToolDefinition = { ... };
export async function handleGnoBacklinks(args: GnoBacklinksArgs): Promise<ToolResponse>;
```

### src/mcp/tools/similar.ts

```typescript
export const gnoSimilarToolDef: ToolDefinition = { ... };
export async function handleGnoSimilar(args: GnoSimilarArgs): Promise<ToolResponse>;
```

### src/mcp/resources/links.ts

```typescript
export const docLinksResourceDef: ResourceDefinition = { ... };
export async function handleDocLinksResource(uri: string): Promise<ResourceResponse>;
```

### src/mcp/tools/index.ts

Register new tools:

```typescript
export const allTools = [
  // existing...
  gnoLinksToolDef,
  gnoBacklinksToolDef,
  gnoSimilarToolDef,
];
```

### src/mcp/resources/index.ts

Register new resource:

```typescript
export const allResources = [
  // existing...
  docLinksResourceDef,
];
```

## Test Coverage

### test/mcp/links-tool.test.ts

- [ ] gno_links returns outgoing links
- [ ] gno_links respects limit parameter
- [ ] gno_links returns error for invalid URI
- [ ] gno_links returns error for missing doc
- [ ] gno_links shows resolved status correctly

### test/mcp/backlinks-tool.test.ts

- [ ] gno_backlinks returns incoming links
- [ ] gno_backlinks with context=true includes text
- [ ] gno_backlinks respects limit
- [ ] gno_backlinks returns error for invalid URI

### test/mcp/similar-tool.test.ts

- [ ] gno_similar returns similar docs
- [ ] gno_similar excludes self and linked
- [ ] gno_similar respects limit
- [ ] gno_similar returns error for invalid URI

### test/mcp/links-resource.test.ts

- [ ] gno://doc/:id/links resource returns links
- [ ] Resource returns error for invalid docId
- [ ] Resource returns error for missing doc

## Acceptance Criteria

- [ ] All three tools implemented and registered
- [ ] Tool input/output schemas match spec
- [ ] Resource implemented and registered
- [ ] Proper error handling for invalid URIs
- [ ] All tests pass
- [ ] Tools documented in MCP.md

---

## [gno-76v] Web UI auto-embed with server-side debounce

**Type:** feature | **Priority:** P1 | **Status:** closed  
**Created:** 2026-01-04 | **Closed:** 2026-01-04

**Close reason:** Implemented server-side debounced embed scheduler with getter-based context survival and correct rerun latch

## Problem

Web UI editor autosaves every 2s. Current implementation embeds on every sync, which:

- Wastes compute on intermediate states
- Could embed unrelated docs (global backlog)
- Fails silently without logging

## Solution: Server-Side Debounced Embedding

### Architecture

```
Edit → Autosave (2s) → Sync (FTS only)
                              ↓
                    Scheduler.notifySyncComplete({docIds})
                              ↓
                    Debounce timer reset (30s)
                    OR max-wait reached (5 min)
                              ↓
                    embedBacklog(docIds) runs once
```

### Key Design Decisions

1. **Single-instance only** - In-memory scheduler (gno serve is single-process)
2. **Global scope** - No workspace/tenant concept in gno
3. **Track dirty docIds** - Only embed docs that changed, not global backlog
4. **Max-wait throttle** - 5 min max to prevent starvation during long edits
5. **Concurrency guard** - running flag + needsRerun latch

### Implementation Plan

#### 1. Create Embed Scheduler (`src/serve/embed-scheduler.ts`)

```typescript
interface EmbedScheduler {
  // Called after sync with list of changed doc IDs
  notifySyncComplete(docIds: string[]): void;

  // Force immediate embed (for Cmd+S)
  triggerNow(): Promise<{ embedded: number; errors: number } | null>;

  // Get current state (for debugging/status)
  getState(): {
    pendingDocCount: number;
    running: boolean;
    nextRunAt?: number;
  };

  // Cleanup on server shutdown
  dispose(): void;
}
```

State management:

- pendingDocIds: Set<string> - accumulated dirty docs
- timer: NodeJS.Timeout - debounce timer
- running: boolean - embed in progress
- needsRerun: boolean - more docs added while running
- firstPendingAt: number - for max-wait calculation

Constants:

- DEBOUNCE_MS = 30_000 (30s)
- MAX_WAIT_MS = 300_000 (5 min)

#### 2. Modify embedBacklog helper

Current: embeds global backlog
New: accepts optional docIds filter

```typescript
async function embedBacklog(
  store: SqliteAdapter,
  embedPort: EmbeddingPort | null,
  vectorIndex: VectorIndexPort | null,
  modelUri: string,
  docIds?: string[] // NEW: filter to specific docs
): Promise<{ embedded: number; errors: number } | null>;
```

Changes:

- Add try/catch wrapper (don't throw)
- Log errors with console.error
- Filter backlog query by docIds if provided
- Return null if no embedPort (graceful degradation)

#### 3. Modify API endpoints

**PUT /api/docs/:id** (handleUpdateDoc)

- Remove inline embedBacklog call from sync job
- After sync completes, call scheduler.notifySyncComplete([docId])

**POST /api/docs** (handleCreateDoc)

- Same pattern as PUT

**POST /api/embed** (NEW endpoint)

- Calls scheduler.triggerNow()
- Returns { embedded, errors } or { running: true, pendingCount }
- Used by Cmd+S handler in frontend

**GET /api/embed/status** (optional, for debugging)

- Returns scheduler.getState()

#### 4. Wire up scheduler in server

**src/serve/server.ts**

- Create scheduler instance with ServerContext
- Pass to route handlers
- Call scheduler.dispose() on shutdown

**src/serve/context.ts**

- Add scheduler to ServerContext (or keep separate)

#### 5. Frontend changes (`DocumentEditor.tsx`)

**Autosave (existing):**

- No change - just saves, backend handles scheduling

**Explicit save (Cmd+S):**

- After PUT succeeds, call POST /api/embed
- Show "Saved & indexed" vs "Saved"

**Idle timeout (optional enhancement):**

- Could add 30s idle timer that calls POST /api/embed
- But server-side scheduler already handles this

### Error Handling

- embedBacklog wrapped in try/catch
- Errors logged server-side
- Sync job always succeeds
- Frontend shows save status, not embed status

### Files to Change

1. `src/serve/embed-scheduler.ts` - NEW (~100 lines)
2. `src/serve/routes/api.ts` - Modify handlers, add POST /api/embed
3. `src/serve/server.ts` - Initialize scheduler
4. `src/serve/public/pages/DocumentEditor.tsx` - Cmd+S calls POST /api/embed
5. `src/store/vector/stats.ts` - Add docId filter to getBacklog (optional)

### Testing

- Unit test embed-scheduler: debounce, max-wait, concurrency
- Integration: rapid saves accumulate, single embed runs
- Manual: edit doc, wait, verify vector search works

### Rollback First

Remove inline embedBacklog calls from handleUpdateDoc and handleCreateDoc sync jobs. Keep the embedBacklog helper function but will modify it.

---

## [gno-vc9] Full documents to answer generation

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2026-01-01 | **Closed:** 2026-01-01

**Close reason:** Full document content (32K chars) to answer generation

Pass full document content to answer LLM instead of 1500-char snippets.

## Why

Current limits cause answer generation to miss critical content:

- MAX_SNIPPET_CHARS = 1500
- MAX_CONTEXT_SOURCES = 5
- Summary tables never reach LLM

## Implementation (src/pipeline/answer.ts)

### Current

```typescript
const MAX_SNIPPET_CHARS = 1500;
const MAX_CONTEXT_SOURCES = 5;
```

### New

```typescript
const MAX_DOC_CHARS = 32000;  // ~8K tokens per doc
const MAX_CONTEXT_SOURCES = 3;  // Fewer docs but full content
const MAX_TOTAL_CONTEXT = 96000;  // ~24K tokens total

for (const r of results.slice(0, MAX_CONTEXT_SOURCES)) {
  const contentResult = await store.getContent(r.conversion?.mirrorHash);
  let content = contentResult.ok ? contentResult.value : r.snippet;

  if (content.length > MAX_DOC_CHARS) {
    content = content.slice(0, MAX_DOC_CHARS) + '\\n\\n[... truncated ...]';
  }

  contextParts.push(\`[\${citationIndex}] \${content}\`);
}
```

## Changes Required

- Pass store to generateGroundedAnswer()
- Fetch full content by mirrorHash

## This EXCEEDS competitor

Competitor doesn't have RAG answers at all. We provide full-doc grounded answers.

Blocks: gno-5hk

---

## [gno-j5t] Full documents to reranker

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2026-01-01 | **Closed:** 2026-01-01

**Close reason:** Full document reranking with 32K context

Send full document content to reranker instead of truncated chunks.

## Why

- Competitor truncates to 4K chars
- We can use Qwen3's 32K context for FULL document reranking
- This EXCEEDS competitor capability

## Implementation (src/pipeline/rerank.ts)

### Current

```typescript
const texts: string[] = toRerank.map((c) => {
  const chunk = getChunk(c.mirrorHash, c.seq);
  return chunk?.text ?? "";
});
```

### New

```typescript
const texts: string[] = await Promise.all(
  toRerank.map(async (c) => {
    const contentResult = await store.getContent(c.mirrorHash);
    if (contentResult.ok && contentResult.value) {
      const content = contentResult.value;
      return content.length > 128000
        ? content.slice(0, 128000) + "..."
        : content;
    }
    const chunk = getChunk(c.mirrorHash, c.seq);
    return chunk?.text ?? "";
  })
);
```

### Dedupe by document

```typescript
// Multiple chunks from same doc -> one rerank call with full doc
const uniqueDocs = new Map<string, ...>();
```

## Best Practices (2025)

- Over-fetch 30+ chunks, rerank together, keep top 10
- Long-context reranking: +13.9% over standard RAG
- Complex financial questions: +16.3% improvement

## Dependencies

Requires: gno-??? (Qwen3-Reranker switch)

Blocks: gno-5hk

---

## [gno-v8d] Original query 2x weight in RRF

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2026-01-01 | **Closed:** 2026-01-01

**Close reason:** Implemented 2x weight for original query in RRF

Give original query results 2x weight vs expansion variants in RRF fusion.

## Why

Expansion queries sometimes dilute exact matches. Original query is most valuable signal.

## Implementation (src/pipeline/fusion.ts)

### Competitor approach

```typescript
// First 2 lists (original FTS + original vector) get 2x weight
const weights = rankedLists.map((_, i) => (i < 2 ? 2.0 : 1.0));
const fused = reciprocalRankFusion(rankedLists, weights);
```

### GNO implementation

```typescript
for (const input of bm25Inputs) {
  const weight =
    input.source === "bm25"
      ? config.bm25Weight * 2.0 // 2x for original
      : config.bm25Weight * 0.5; // 0.5x for variants
}

for (const input of vectorInputs) {
  if (input.source === "vector") {
    weight = config.vecWeight * 2.0; // 2x for original
  } else if (input.source === "vector_variant") {
    weight = config.vecWeight * 0.5;
  } else if (input.source === "hyde") {
    weight = config.vecWeight * 0.7;
  }
}
```

## Best Practices (2025)

- RRF k=60 remains robust default
- Equal weights usually preferred, but 2x original helps prevent dilution
- Only add weights when empirical evidence shows benefit

Blocks: gno-5hk

---

## [gno-xnt] Document-level BM25 + Porter stemmer

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2026-01-01 | **Closed:** 2026-01-01

**Close reason:** Implemented document-level BM25 with Snowball stemmer. Migration 002, fts5-snowball loader, syncDocumentFts. All 625 tests pass.

Switch BM25/FTS from chunk-level to document-level indexing with Snowball stemmer.

## No Backwards Compat Needed

No users yet - just change schema directly, delete old code.

## Why

- Current chunk-level FTS fails when query terms span chunks
- No stemming means "scored" doesn't match "score"

## Implementation

### 1. Build/test fts5-snowball

Test during implementation. If works (expected), use it. If not, fall back to `porter unicode61`.

### 2. Replace FTS table in migration (src/store/migrations/)

```sql
-- Delete old content_fts, create new documents_fts
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  filepath, title, body,
  tokenize='snowball english'
);
```

### 3. Add auto-sync triggers

### 4. Update searchFts() in src/store/sqlite/adapter.ts

## Scope: `snowball english` default

- Single FTS table, one tokenizer for all collections
- English Snowball still better than `unicode61` for all languages
- Proper multilingual = future work (gno-9jl)

See notes/epic-search-quality-improvements.md for full context.
Depends on: gno-ad6 (TDD tests first)

Blocks: gno-5hk

---

## [gno-ad6] Add failing search quality tests (TDD)

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2026-01-01 | **Closed:** 2026-01-01

**Close reason:** Added 9 failing TDD tests for search quality

Add tests that FAIL with current implementation, proving the problem exists.
After epic implementation, these tests should pass.

## Test Cases (from root cause analysis)

### 1. Cross-chunk query terms

```typescript
test("finds document when query terms span multiple chunks", async () => {
  // "gmickel-bench" in chunk 1, "score table" in chunk 18
  const results = await query("which model scored best on gmickel-bench?");
  expect(results).toContainDocument("AI Coding Assistant Eval Results.md");
});
```

### 2. Stemming

```typescript
test('stemming: "scored" matches "score"', async () => {
  const results = await search("scored best");
  expect(results.some((r) => r.content.includes("score"))).toBe(true);
});

test('stemming: "running" matches "run"', async () => {
  const results = await search("running tests");
  expect(results.some((r) => r.content.includes("run test"))).toBe(true);
});
```

### 3. Answer generation with full context

```typescript
test("answer includes data from document tables", async () => {
  const answer = await ask("which model scored best on gmickel-bench?", {
    answer: true,
  });
  expect(answer.text).toContain("494.6"); // or GPT-5.2-xhigh
  expect(answer.citations).toHaveLength(1);
});
```

### 4. Cross-document synthesis

```typescript
test("synthesizes answer from multiple documents", async () => {
  const answer = await ask("compare async programming in go and python", {
    answer: true,
  });
  expect(answer.citations.length).toBeGreaterThan(1);
});
```

## Implementation

- Add to test/pipeline/search-quality.test.ts (new file)
- Use existing fixtures or add new ones
- Mark as `.skip` initially if needed, but document expected behavior
- Run before/after epic to verify improvement

## Why TDD

- Proves the problem exists
- Prevents regressions
- Clear success criteria for the epic

See notes/epic-search-quality-improvements.md for full context.

Blocks: gno-5hk
Should be done FIRST before any implementation.

---

## [gno-3qp.2] T10.2: Implement MCP tools (gno.search/vsearch/query/get/multi_get/status)

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-30

**Close reason:** Closed

# T10.2: Implement MCP Tools

## Goal

Implement all 6 MCP tools per spec/mcp.md with exception firewall, mutex, and input validation.

## Architecture

### Tool Context (src/mcp/context.ts)

```typescript
import type { SqliteAdapter } from "../store/sqlite/adapter.js";
import type { Config, Collection } from "../config/types.js";
import type { Mutex } from "async-mutex";
import type { LlmAdapter } from "../llm/adapter.js";

export interface ToolContext {
  store: SqliteAdapter;
  config: Config;
  collections: Collection[];
  actualConfigPath: string;
  toolMutex: Mutex;
  modelManager?: ModelManager;
  isShuttingDown: () => boolean;
}

// Model lifecycle with retry-safe states
export interface ModelManager {
  state: "idle" | "loading" | "ready" | "error";
  adapter?: LlmAdapter;
  getAdapter(): Promise<LlmAdapter>; // returns cached or initializes
  dispose(): Promise<void>; // best-effort, non-throwing
}

// Retry-safe implementation
class ModelManagerImpl implements ModelManager {
  state: "idle" | "loading" | "ready" | "error" = "idle";
  adapter?: LlmAdapter;
  private loadPromise?: Promise<LlmAdapter>;

  async getAdapter(): Promise<LlmAdapter> {
    if (this.state === "ready" && this.adapter) return this.adapter;
    if (this.state === "loading" && this.loadPromise) return this.loadPromise;

    // Reset error state to allow retry
    this.state = "loading";
    this.loadPromise = this.doLoad();

    try {
      this.adapter = await this.loadPromise;
      this.state = "ready";
      return this.adapter;
    } catch (e) {
      this.state = "idle"; // Allow retry on next call
      this.loadPromise = undefined;
      throw e;
    }
  }

  private async doLoad(): Promise<LlmAdapter> {
    // Initialize LlmAdapter with config...
  }

  async dispose(): Promise<void> {
    try {
      await this.adapter?.dispose?.();
    } catch {
      /* ignore */
    }
    this.adapter = undefined;
    this.state = "idle";
  }
}
```

### Tool Registration (src/mcp/tools/index.ts)

```typescript
import { z } from "zod";
import type {
  McpServer,
  CallToolResult,
} from "@modelcontextprotocol/sdk/server/mcp.js";

// DRY helper: exception firewall + response shaping + mutex
export async function runTool<T>(
  ctx: ToolContext,
  name: string,
  fn: () => Promise<T>,
  formatText: (data: T) => string
): Promise<CallToolResult> {
  // Check shutdown
  if (ctx.isShuttingDown()) {
    return {
      isError: true,
      content: [{ type: "text", text: "Error: Server is shutting down" }],
    };
  }

  // Sequential execution via mutex
  const release = await ctx.toolMutex.acquire();
  try {
    const data = await fn();
    return {
      content: [{ type: "text", text: formatText(data) }],
      structuredContent: data,
    };
  } catch (e) {
    // Exception firewall: never throw, always return isError
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  } finally {
    release();
  }
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  // Tool IDs exactly per spec
  server.tool("gno.search", searchInputSchema, (args) =>
    handleSearch(args, ctx)
  );
  server.tool("gno.vsearch", vsearchInputSchema, (args) =>
    handleVsearch(args, ctx)
  );
  server.tool("gno.query", queryInputSchema, (args) => handleQuery(args, ctx));
  server.tool("gno.get", getInputSchema, (args) => handleGet(args, ctx));
  server.tool("gno.multi_get", multiGetInputSchema, (args) =>
    handleMultiGet(args, ctx)
  ); // underscore!
  server.tool("gno.status", statusInputSchema, (args) =>
    handleStatus(args, ctx)
  );
}
```

### Input Validation (zod v4.2.1 - already in deps)

```typescript
import { z } from "zod";

const searchInputSchema = {
  query: z.string().min(1, "Query cannot be empty"),
  collection: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(5),
  minScore: z.number().min(0).max(1).optional(),
  lang: z.string().optional(),
};

function validateSearchInput(args: unknown, ctx: ToolContext) {
  const parsed = searchInputSchema.parse(args);
  if (
    parsed.collection &&
    !ctx.collections.find((c) => c.name === parsed.collection)
  ) {
    throw new Error(`Collection not found: ${parsed.collection}`);
  }
  return parsed;
}
```

### absPath Enrichment (CRITICAL: derive collection from result, not input)

```typescript
import path from "node:path";
import { parseUri } from "../../app/constants.js";

// CORRECT: Derive collection from result's URI, not tool input
function enrichWithAbsPath(
  results: SearchResults,
  collections: Collection[]
): SearchResults {
  return {
    ...results,
    results: results.results.map((r) => {
      // Parse collection from result's URI (handles multi-collection searches)
      const { collection: collName } = parseUri(r.uri);
      const collection = collections.find((c) => c.name === collName);
      const absPath = collection
        ? path.join(collection.root, r.source.relPath)
        : r.source.relPath;

      return {
        ...r,
        source: { ...r.source, absPath },
      };
    }),
  };
}
```

## Tools

### gno.search (src/mcp/tools/search.ts)

- Validate input (query required, limit 1-100, collection exists)
- Wrap `searchBm25()` from pipeline/search.ts
- Enrich with absPath (derived from result's collection)
- Return content[] + structuredContent

### gno.vsearch (src/mcp/tools/vsearch.ts)

- Validate input
- Get adapter from ModelManager (retry-safe, allows retry on failure)
- Wrap `searchVectorWithEmbedding()` from pipeline/vsearch.ts
- Graceful error if no vector index: isError:true + suggest `gno index`
- Enrich with absPath

### gno.query (src/mcp/tools/query.ts)

- Validate input
- Get adapter from ModelManager
- Wrap `searchHybrid()` from pipeline/hybrid.ts
- Graceful degradation per spec (vectorsUsed, expanded, reranked flags)
- Enrich with absPath

### gno.get (src/mcp/tools/get.ts)

- Validate ref format (URI, collection/path, #docid)
- Normalize gno:// URI using parseUri+buildUri from constants.ts
- Include source.absPath in response

### gno.multi_get (src/mcp/tools/multi-get.ts)

- Tool ID is `gno.multi_get` (underscore per spec)
- Support refs[] OR pattern (not both)
- Implement maxBytes truncation
- Return skipped[] for docs exceeding limit
- Include source.absPath in all documents

### gno.status (src/mcp/tools/status.ts)

- No input params
- Return collections, doc counts, health status
- Include truthful actualConfigPath in response

## Acceptance Criteria

- [ ] All 6 tools registered with exact spec names
- [ ] Input validation via Zod (already in deps v4.2.1)
- [ ] Output matches spec/output-schemas/\*.json
- [ ] Errors return isError:true via exception firewall (never throw)
- [ ] **absPath derived from result's URI** (not tool input collection)
- [ ] Graceful degradation for missing vectors/models
- [ ] All tools execute sequentially via mutex
- [ ] ModelManager allows retry after failure (no cached broken state)
- [ ] Shutdown check in runTool prevents new work

## References

- spec/mcp.md - Full tool specs
- spec/output-schemas/ - Response schemas
- src/app/constants.ts - parseUri/buildUri for URI handling
- src/pipeline/search.ts:124 - searchBm25
- src/pipeline/vsearch.ts - searchVectorWithEmbedding
- src/pipeline/hybrid.ts - searchHybrid

---

## [gno-3qp.1] T10.1: MCP server skeleton

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-30

**Close reason:** Closed

# T10.1: MCP Server Skeleton

## Goal

`gno mcp` starts stdio MCP server with persistent DB connection, honoring --index and --config.

## Implementation

### 1. CLI Entry Point (src/cli/commands/mcp.ts)

```typescript
import type { GlobalOptions } from "../options.js";

export async function mcpCommand(options: GlobalOptions): Promise<void> {
  const { startMcpServer } = await import("../../mcp/server.js");
  await startMcpServer({
    indexName: options.index,
    configPath: options.config,
    verbose: options.verbose,
  });
}
```

### 2. Server Setup (src/mcp/server.ts)

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../app/constants.js";
import { initStore } from "../cli/commands/shared.js";
import { Mutex } from "async-mutex";

interface McpServerOptions {
  indexName?: string;
  configPath?: string;
  verbose?: boolean;
}

export async function startMcpServer(options: McpServerOptions): Promise<void> {
  // ========================================
  // STDOUT PURITY GUARD (CRITICAL)
  // ========================================
  // Wrap stdout to catch accidental writes
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let protocolMode = false;
  process.stdout.write = (chunk: any, ...args: any[]) => {
    if (!protocolMode) {
      // During init, redirect to stderr
      return process.stderr.write(chunk, ...args);
    }
    // After transport connected, allow JSON-RPC only
    return originalStdoutWrite(chunk, ...args);
  };

  // Open DB once with index/config threading
  const init = await initStore({
    indexName: options.indexName,
    configPath: options.configPath,
    verbose: options.verbose ?? false,
  });

  if (!init.ok) {
    console.error("Failed to initialize:", init.error);
    process.exit(1);
  }
  const { store, config, collections, actualConfigPath } = init;

  // Create MCP server
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
    }
  );

  // Sequential execution mutex
  const toolMutex = new Mutex();

  // Shutdown state
  let shuttingDown = false;

  // Tool context (passed to all handlers)
  const ctx = {
    store,
    config,
    collections,
    actualConfigPath,
    toolMutex,
    isShuttingDown: () => shuttingDown,
  };

  // Register tools (T10.2) - pass ctx
  // Register resources (T10.3) - pass ctx

  // ========================================
  // GRACEFUL SHUTDOWN (ordered)
  // ========================================
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    // 1. Stop accepting new messages (SDK handles this on close)

    // 2. Wait for current handler (bounded timeout via mutex tryAcquire)
    const release = await Promise.race([
      toolMutex.acquire(),
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]);
    if (release && typeof release === "function") release();

    // 3. Dispose model ports (best-effort, non-throwing)
    try {
      if (ctx.modelManager?.adapter) {
        await ctx.modelManager.adapter.dispose?.();
      }
    } catch {
      /* ignore */
    }

    // 4. Close DB
    await store.close();

    // 5. Exit
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Connect transport
  const transport = new StdioServerTransport();
  protocolMode = true; // Enable stdout for JSON-RPC
  await server.connect(transport);
  console.error("GNO MCP server running on stdio");
}
```

### 3. Wire CLI (src/cli/program.ts)

Replace stub at line 710-718. CRITICAL: Ensure Commander doesn't print help to stdout:

```typescript
function wireMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("Start MCP server (stdio transport)")
    .helpOption(false) // Disable --help to prevent stdout pollution
    .action(async () => {
      const { mcpCommand } = await import("./commands/mcp.js");
      const globalOpts = program.opts();
      await mcpCommand(globalOpts);
    });
}
```

### 4. Update SqliteAdapter (src/store/sqlite/adapter.ts)

Move WAL + busy_timeout to lowest level (open time):

```typescript
// In SqliteAdapter.open() or constructor, immediately after db open:
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA busy_timeout=5000");
```

This ensures ALL connections (CLI, MCP, tests) get proper concurrency handling.

### 5. Update initStore (src/cli/commands/shared.ts)

Add `indexName` and `configPath` to InitStoreOptions:

```typescript
interface InitStoreOptions {
  verbose?: boolean;
  indexName?: string; // honor --index flag
  configPath?: string; // honor --config flag
}

interface InitStoreResult {
  ok: true;
  store: SqliteAdapter;
  config: Config;
  collections: Collection[];
  actualConfigPath: string; // truthful path for status
}
```

## Config Drift Policy

**Decision: Load-once, no hot reload**

- Config loaded at server startup
- Collections/contexts synced once
- If user edits config, must restart `gno mcp`
- Document this behavior in docs/MCP.md

## Acceptance Criteria

- [ ] `gno mcp` starts without error
- [ ] Honors `--index <name>` flag (opens correct DB)
- [ ] Honors `--config <path>` flag (loads correct config)
- [ ] Server responds to MCP initialize request
- [ ] **NO stdout except JSON-RPC** (Commander help disabled, stdout guard active)
- [ ] DB stays open during session (WAL mode in SqliteAdapter.open)
- [ ] SIGTERM/SIGINT: ordered shutdown (wait handler → dispose models → close DB → exit)
- [ ] stderr shows startup message
- [ ] shuttingDown flag prevents new work during shutdown

## Dependencies

- @modelcontextprotocol/sdk (already in package.json)
- zod (already in package.json v4.2.1)
- async-mutex (add) OR implement simple promise mutex

## References

- src/cli/program.ts:710-718 (stub to replace)
- src/cli/commands/shared.ts:42-109 (initStore pattern)
- src/store/sqlite/adapter.ts (WAL pragma location)
- src/app/constants.ts:33-40 (MCP constants)

---

## [gno-h7i] EPIC 8: Search pipelines

**Type:** epic | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-30

**Close reason:** Search pipelines complete - all tests passing

---

## [gno-8n2.8] D7: GNO design system (assets/css/style.scss)

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-29 | **Closed:** 2025-12-29

**Close reason:** Closed

SCSS with CSS variables. [USES frontend-design PLUGIN - CRITICAL]

**Brand Brief for GNO:**

- Name origin: Greek 'gnosis' = knowledge, wisdom, discovery
- Mood: Clean, intelligent, trustworthy - like a personal librarian
- NOT: Cold/corporate, overly playful, generic tech startup, Terminal Noir clone
- Color direction: Deep blues or teals (knowledge/depth), warm accents (approachable), neutral backgrounds
- Typography: Mono for code/headings (tool feel), clean sans for body (readable)
- Icon concept: Search + knowledge (magnifying glass + book/brain/index)
- Dark mode default, light mode available
- Feel: Local-first, privacy-respecting, powerful but not intimidating

**Technical scope:**

- Design tokens (colors, spacing, typography, shadows, radii)
- Dark/light theme CSS variables
- Component styles: header, sidebar, nav, cards, code blocks, tables, buttons
- Syntax highlighting (Rouge)
- Animations (subtle, purposeful)
- Print styles
- Mobile responsive breakpoints

---

## [gno-n5m.2] T9.2: gno get and multi-get with limits and skipped records

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-27

**Close reason:** Implemented in commit a7152f8

gno get <ref> retrieves single doc by gno:// URI, collection/path, or #docid. Supports :line suffix, --from, -l, --line-numbers, --source. gno multi-get for multiple docs with --max-bytes limit. Reference: docs/prd.md §13.

---

## [gno-h7i.2] T8.2: gno vsearch (vector only)

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-25

**Close reason:** Implemented in PR #9

Vector similarity search. Same output schema as search. Graceful error if vectors unavailable (suggest gno index/embed). Reference: docs/prd.md §12.1 and §11.3.

---

## [gno-h7i.1] T8.1: gno search (BM25/FTS only)

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-25

**Close reason:** Implemented in PR #9

FTS-only search. Options: -n limit, --min-score, -c collection, --full, --line-numbers, --lang. Output: docid, score, uri, title, snippet, snippetRange, source metadata. Reference: docs/prd.md §12.1 and §15.1.

---

## [gno-ia1] EPIC 7: Vector index and embeddings workflow (gno embed)

**Type:** epic | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-25

**Close reason:** EPIC 7 complete: vector index, stats, embed command merged

---

## [gno-ia1.3] T7.3: Batch embed chunks and store vectors per model

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-25

**Close reason:** Completed in EPIC 7 vector embeddings PR

'gno embed [--force] [--model] [--batch-size]' embeds pending chunks. Store vectors keyed by (mirror_hash, seq, model). Batching for efficiency. Reference: docs/prd.md §14.2.

---

## [gno-ia1.1] T7.1: sqlite-vec integration (handle optional deps cleanly)

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-25

**Close reason:** Completed in EPIC 7 vector embeddings PR

Integrate sqlite-vec for vector storage. Handle as optional dep - graceful degradation if unavailable. content_vectors table: (mirror_hash, seq, model) PK, embedding blob, embedded_at. Reference: docs/prd.md §9.2.

---

## [gno-v8w.1] T6.1: LLM adapter lifecycle management

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-24

**Close reason:** Implemented in PR #4

node-llama-cpp adapter for embeddings, generation, reranking. Keep models loaded for repeated calls. Dispose contexts/sequences promptly. Safe memory management for long MCP sessions. Reference: docs/prd.md §11.1.

---

## [gno-v8w] EPIC 6: LLM subsystem (node-llama-cpp) and model UX

**Type:** epic | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-24

**Close reason:** Implemented in PR #4

---

## [gno-i7b.2] T5.2: Sync algorithm (hash, convert, upsert, soft-delete)

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-24

**Close reason:** Merged to main

For each file: stat, read bytes, compute source_hash (sha256), detect MIME, convert to markdown mirror, compute mirror_hash, upsert doc keyed by (collection, relativePath). Mark missing files inactive. Store converter_id/version. Reference: docs/prd.md §7.2.

---

## [gno-i7b.1] T5.1: File walker + include/exclude logic + path normalization

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-24

**Close reason:** Merged to main

Walk collection directory matching glob pattern. Support include (extensions allowlist) and exclude (patterns like .git, node_modules). Deterministic path normalization. Use Bun.file for reading. Reference: docs/prd.md §7.1.

---

## [gno-i7b] EPIC 5: Indexing sync (gno update) and FTS

**Type:** epic | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-24

**Close reason:** Merged to main

---

## [gno-mu3.4] T4.4: Native markdown/plaintext converters

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-24

**Close reason:** Merged to main

Implement native/markdown (passthrough + canonicalization) and native/plaintext (wrap as markdown + canonicalization) converters. Reference: docs/prd.md §8.6.

---

## [gno-mu3.3] T4.3: Converter interfaces, registry, error mapping + tests

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-24

**Close reason:** Merged to main

Types in src/converters/types.ts: ConverterId, ConvertInput, ConvertWarning, ConvertOutput, ConvertResult, Converter interface. Error codes: UNSUPPORTED, TOO_LARGE, TIMEOUT, CORRUPT, etc. Registry selects first canHandle() match. Reference: docs/prd.md §8.2-§8.3.

---

## [gno-mu3.2] T4.2: Canonical Markdown normalizer + tests

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-24

**Close reason:** Merged to main

Deterministic normalization rules: \n newlines, strip \u0000 and non-printables except \n\t, trim trailing whitespace per line, collapse 3+ blank lines to 2, ensure single final newline. NO timestamps or paths in output. Reference: docs/prd.md §8.4.

---

## [gno-mu3.1] T4.1: MIME detector + tests

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-24

**Close reason:** Merged to main

Implement MimeDetector interface. Layered detection: 1) extension map (.md→text/markdown, .pdf→application/pdf, etc.), 2) byte sniffing (%PDF-, PK zip header). Return {mime, ext, confidence, via}. Reference: docs/prd.md §8.5.

---

## [gno-mu3] EPIC 4: Converter subsystem (Node-only, deterministic)

**Type:** epic | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-24

**Close reason:** Merged to main

---

## [gno-a7n] EPIC 3: Store layer (SQLite + migrations)

**Type:** epic | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-23

**Close reason:** Implemented in previous session - migrations, core tables, adapter, status queries all complete. 191 tests passing.

---

## [gno-a7n.2] T3.2: Implement core tables and queries

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-23

**Close reason:** Implemented in previous session - migrations, core tables, adapter, status queries all complete. 191 tests passing.

Tables: collections, contexts, documents, content, content_chunks, content_fts (FTS5), content_vectors, llm_cache, ingest_errors. Key fields in docs/prd.md §9.2. Use bun:sqlite.

---

## [gno-a7n.1] T3.1: Implement migrations runner

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-23

**Close reason:** Implemented in previous session - migrations, core tables, adapter, status queries all complete. 191 tests passing.

SQLite migrations system. DB path: <dataDir>/index-<indexName>.sqlite. Run migrations on init/first access. Use bun:sqlite. Reference: docs/prd.md §9.

---

## [gno-du9] EPIC 2: Config, collections, contexts

**Type:** epic | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-23

**Close reason:** EPIC 2 complete: config schema, loader/saver, collection/context/init commands, multilingual support

---

## [gno-du9.4] T2.4: init command (idempotent, creates config+DB, optional collection add)

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-23

**Close reason:** Implemented: all commands working, 43 tests passing

gno init [<path>] [--name] [--pattern] [--yes] creates config if missing, runs DB migrations, optionally adds collection. Must be idempotent and safe to run repeatedly. Print resolved paths. Reference: docs/prd.md §7.1.

---

## [gno-du9.1] T2.1: Config schema + loader/saver (YAML), XDG defaults, overrides

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-23

**Close reason:** Config schema, loader, saver complete with tests

Implement config loading from YAML file at <configDir>/index.yml. Support XDG paths (Linux), Library/Application Support (macOS), AppData (Windows). Environment overrides: GNO_CONFIG_DIR, GNO_DATA_DIR, GNO_CACHE_DIR. Reference: docs/prd.md §2.1-§2.3.

---

## [gno-kos] EPIC 1: Specs and contract tests (freeze interfaces early)

**Type:** epic | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-23

**Close reason:** All child tasks complete

---

## [gno-kos.3] T1.3: Write spec/output-schemas/\*.json

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-23

**Close reason:** Closed

Create JSON schemas for: search result item, status payload, get payload, multi-get payload, MCP tool outputs, ask payload. Reference: docs/prd.md §15.

---

## [gno-kos.2] T1.2: Write spec/mcp.md (tools/resources, schemas, versioning)

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-23

**Close reason:** Closed

Document MCP server spec: stdio transport, tools (gno.search/vsearch/query/get/multi_get/status), resources (gno:// URIs), schema versioning rules. Reference: docs/prd.md §16.

---

## [gno-kos.1] T1.1: Write spec/cli.md (commands, flags, exit codes, output formats)

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-23

**Close reason:** Closed

Document all CLI commands from §14, flags, exit codes (0/1/2), output format flags (--json/--files/--csv/--md/--xml). Reference: docs/prd.md §14.

---

## [gno-8db] EPIC 0: Repo scaffold and naming constants

**Type:** epic | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-23

**Close reason:** All tasks complete: scaffold, constants module, CI

---

## [gno-8db.2] T0.2: Central constants module for naming (CLI, URI, dirs, MCP)

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-23

**Close reason:** Implemented: folder structure per PRD, constants module with OS paths/env overrides, 33 passing tests

Create src/app/constants.ts with all configurable names: CLI name ("gno"), URI scheme ("gno://"), config/data/cache dir names, MCP server name, MCP tool namespace prefix. Must be single-module rename. Reference: docs/prd.md §2.2.

---

## [gno-8db.1] T0.1: Bun+TS ESM scaffold with lint/typecheck/test baseline

**Type:** task | **Priority:** P0 | **Status:** closed  
**Created:** 2025-12-23 | **Closed:** 2025-12-23

**Close reason:** Implemented: folder structure per PRD, constants module with OS paths/env overrides, 33 passing tests

Set up Bun + TypeScript ESM project. Configure biome for linting/formatting, tsgo for typecheck, bun test for testing. Verify with `bun test` passing. Reference: docs/prd.md §22 EPIC 0.

---
