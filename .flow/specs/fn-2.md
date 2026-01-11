# Obsidian-compatible wiki link resolution

**Migrated from:** gno-65x
**Original type:** feature
**Priority:** P1

---

## Problem

Wiki links with absolute vault paths don't resolve. Obsidian supports multiple link formats:

1. **Shortest path** - `[[Note]]` → matches title ✅ works
2. **Relative path** - `[[../folder/Note]]` → needs resolution
3. **Absolute vault path** - `[[folder/subfolder/Note.md]]` → broken ❌

Currently stored `target_ref_norm` contains the full path, but resolution only matches:

- Wiki: `lower(trim(title)) = target_ref_norm`
- Markdown: `rel_path = target_ref_norm`

Neither works for Obsidian absolute paths where:

- `target_ref_norm` = `02 action/02 projects/gmickel-bench/note.md`
- `rel_path` = `Note.md` (relative to collection root)
- `title` = `My Note Title` (from frontmatter)

## Affected Features

- Graph visualization - links don't form edges
- Sidebar outgoing links - show as unresolved
- Backlinks - won't find sources using path-style wiki links
- `gno links` CLI - shows broken links

## Solution: Multi-strategy Resolution

Add fallback resolution strategies for wiki links containing paths:

### 1. Resolution Layer (adapter.ts)

```typescript
// resolveLinks() and getGraph() need fallback logic:
async resolveWikiLink(targetRefNorm: string, collection: string): Promise<Doc | null> {
  // Strategy 1: Title match (current)
  let doc = await matchByTitle(targetRefNorm, collection);
  if (doc) return doc;

  // Strategy 2: If looks like path, try basename title match
  if (targetRefNorm.includes('/') || targetRefNorm.endsWith('.md')) {
    const basename = extractBasename(targetRefNorm); // strips path + .md
    doc = await matchByTitle(normalizeWikiName(basename), collection);
    if (doc) return doc;
  }

  // Strategy 3: Case-insensitive rel_path match
  doc = await matchByRelPath(targetRefNorm, collection);
  if (doc) return doc;

  // Strategy 4: Basename rel_path match
  if (targetRefNorm.includes('/')) {
    const basename = path.basename(targetRefNorm);
    doc = await matchByRelPathCaseInsensitive(basename, collection);
  }

  return null;
}
```

### 2. Graph Query Update

Update `getGraph()` CTE to use same multi-strategy matching:

```sql
-- Wiki link resolution with fallback
CASE dl.link_type WHEN 'wiki' THEN (
  SELECT t.id FROM documents t WHERE t.active = 1
    AND t.collection = COALESCE(dl.target_collection, d.collection)
    AND (
      -- Strategy 1: Title match
      lower(trim(t.title)) = dl.target_ref_norm
      -- Strategy 2: Basename title match (for paths)
      OR (dl.target_ref_norm LIKE '%/%' AND lower(trim(t.title)) =
          lower(replace(replace(substr(dl.target_ref_norm,
            instr(dl.target_ref_norm, '/') + 1), '.md', ''), '-', ' ')))
      -- Strategy 3: rel_path match
      OR lower(t.rel_path) = dl.target_ref_norm
    )
  ORDER BY t.id LIMIT 1
)
```

### 3. Backlinks Query Update

Update `getBacklinksForDoc()` to find sources using path-style links:

```typescript
// For wiki backlinks, match against:
// 1. Normalized title (current)
// 2. Paths ending with this doc's filename
// 3. Paths where basename matches title
```

## Deliverables

1. [ ] `src/core/links.ts` - Add `extractWikiBasename()` helper
2. [ ] `src/store/sqlite/adapter.ts`:
   - [ ] Update `resolveLinks()` with fallback strategies
   - [ ] Update `getGraph()` CTE with multi-strategy matching
   - [ ] Update `getBacklinksForDoc()` to handle path-style sources
3. [ ] Tests for each resolution strategy
4. [ ] Reindex NOT required - resolution is query-time

## Test Cases

```typescript
// Path-style wiki links should resolve
'[[folder/Note.md]]' → matches doc with title "Note" or rel_path "Note.md"
'[[02 Action/Projects/Task.md]]' → matches "Task.md" in same collection
'[[collection:path/to/Doc]]' → cross-collection with path

// Edge cases
'[[Note]]' → still matches by title (no regression)
'[[Note.md]]' → matches title "Note" or rel_path "Note.md"
```

## Acceptance Criteria

- [ ] Obsidian absolute-path wiki links resolve in graph
- [ ] Outgoing links panel shows resolved status
- [ ] Backlinks work for docs linked via paths
- [ ] No regression for simple `[[Note]]` style links
- [ ] No reindex required

## Plan

### Overview

- fix path-style wiki resolution (vault-absolute / vault-root-relative) at query time
- out of scope: ../ wiki relative (needs source path or reindex)

### Scope

- core helpers: pathlike predicate + path parts + canonical normalization (POSIX)
- schema: doc-centric key index table for wiki resolution
- adapter: resolveLinks + getBacklinksForDoc + getGraph via key index (no suffix LIKE)
- explicit ambiguity handling in SQL (no ORDER BY id fallback)
- CLI: always use store.resolveLinks; ambiguous treated as unresolved
- tests: store + sync + CLI + serve + graph meta + ambiguity + pathlike predicate
- docs: clarify actual resolution order + scope + unsupported ./../ wiki

### Approach

- `src/core/links.ts`:
  - `isPathLikeWikiRef(ref)` = ref.includes("/") OR endswith `.md/.mdx` (no path-mode for `[[Note]]`)
  - use existing `normalizeWikiName()` as the only wiki key normalizer (NFC+lower+trim)
  - `extractWikiPathParts(ref)` => { basename, stem, ext, hasDirs }
  - `buildWikiTailCandidates(ref)` => tails + extension variants from slash splits
  - sanitize: reject `\0` and `..` segments only (allow `.` but treat `./` as unsupported)
- schema/index:
  - new table `doc_link_targets` (doc-centric):
    - `doc_id INTEGER REFERENCES documents(id) ON DELETE CASCADE`
    - `collection TEXT NOT NULL`
    - `key TEXT NOT NULL` (normalized via normalizeWikiName)
    - `kind TEXT NOT NULL` (title | rel_path | tail | stem)
    - `key_len INTEGER NOT NULL` (tie-break within same kind/rank only)
    - `UNIQUE(doc_id, key, kind)`
    - index `(collection, key, kind)`
  - keys inserted per doc:
    - kind=title: normalizeWikiName(title) if title present
    - kind=rel_path: normalizeWikiName(rel_path) always
    - kind=stem: normalizeWikiName(stem(rel_path)) always
    - kind=tail: normalizeWikiName(each tail of rel_path) always (includes basename tail)
  - backfill migration: `SELECT id, collection, rel_path, title FROM documents WHERE active=1` (even if mirror_hash null), generate keys from title + rel_path, insert in one transaction w/ prepared statements; note possible WAL growth/time
  - keep doc_link_targets synced on every document upsert (title/rel_path/collection change) via delete+insert
  - collection rename: update doc_link_targets.collection or rebuild affected doc_ids in same txn
  - when marking docs inactive: delete their doc_link_targets rows (keeps index lean)
- resolveLinks/getBacklinks/getGraph:
  - all wiki target lookups go through doc_link_targets (no direct `lower(title)` scans)
  - always join `documents` with `active=1`
- resolveLinks (wiki):
  - non-pathlike: lookup title key in doc_link_targets
  - pathlike: build candidate keys from ref; query doc_link_targets by `collection + key IN (...)` and rank by kind + key_len; if tie at best rank => unresolved
- getBacklinksForDoc:
  - build key set from target doc (title key, rel_path, stem, tails, ext variants)
  - query doc_links by `target_ref_norm` (title key) + doc_link_targets by `key IN (...)`; apply same rank + tie check
  - collection scoping is outer AND
- getGraph:
  - CTE pipeline: candidates -> DISTINCT (link_id,target_doc_id,rank,key_len) -> window best_rank + tie_count -> accept only best_count=1
  - dedup must collapse multi-key matches for same target_doc_id
  - reuse same CTE for outgoing/incoming/edge count/edge query/linkedOnly
- `target_ref_norm` wording: normalized wiki ref string (slashes preserved); no reindex
- note: keep nodeIdList cap conservative; watch SQL length if caps rise

### Acceptance

- Obsidian absolute-path wiki links resolve in graph + backlinks + API + CLI
- vault-root-relative wiki paths resolve when rel_path tail matches
- extensionless path refs resolve via `.md/.mdx` candidates
- no regression for simple `[[Note]]`
- ../ wiki relative + ./ wiki stay unsupported (documented)
- inactive targets never resolve

### Tests

- store: `test/store/links.test.ts` (resolveLinks + backlinks pathlike + ambiguity + inactive target)
- sync: `test/ingestion/sync-links.test.ts` (Obsidian path wiki; doc w/ mirror_hash NULL resolves via rel_path)
- CLI: `test/cli/commands/links.test.ts` (resolved output via store; ambiguous treated as unresolved)
- core: `test/core/links.test.ts` (isPathLikeWikiRef: `[[Note]]` false, `[[folder/Note]]` true)
- serve: `test/serve/routes/links.test.ts` or `test/serve/api-links.test.ts`
- graph meta: new store test validates degree/edges/unresolved counts incl ambiguity + multi-key match dedup

### Risks

- doc_link_targets backfill cost on huge vaults; document expected time
- ambiguous matches hide edges; better than wrong edges

### Docs

- update `docs/ARCHITECTURE.md` + `docs/GLOSSARY.md` to reflect actual order + scope + unsupported ./../ wiki

### References

- `src/ingestion/sync.ts:433-474`
- `src/core/links.ts:118-124`
- `src/store/sqlite/adapter.ts:1392-1564`
- `src/store/sqlite/adapter.ts:1616-1811`
- `src/cli/commands/links.ts:1-520`
- `docs/GLOSSARY.md:140-142`
- `docs/ARCHITECTURE.md:221-227`
- `test/store/links.test.ts:367-520`
- `test/ingestion/sync-links.test.ts:446-504`
- `test/cli/commands/links.test.ts:1-200`
