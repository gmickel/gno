/**
 * Workspace-wide wiki link resolution (Obsidian semantics) for plain
 * `[[Target]]` links whose source document belongs to a link workspace.
 *
 * One ranking function serves both candidate strategies: a SQL basename
 * prefilter for small target sets and a bulk load of every workspace member
 * for large ones. Both feed identical rows into the same in-memory index, so
 * results never depend on the strategy or on insertion order.
 *
 * Document-side case folding mirrors SQLite `lower()` (ASCII only), the
 * documented caveat shared with collection-scoped resolution.
 *
 * @module src/store/sqlite/workspace-link-resolver
 */

import type { Database } from "bun:sqlite";

// node:path/posix: POSIX path algebra for workspace-relative paths; no Bun equivalent.
import { posix as pathPosix } from "node:path";

import type {
  CollectionWorkspaceMembership,
  LinkWorkspaceSource,
} from "../../core/link-workspace";

import { placeDocument } from "../../core/link-workspace";
import { stripWikiMdExt } from "../../core/links";

/** Why a workspace link resolved to its target. */
export type WorkspaceResolutionReason =
  /** Exact path relative to the workspace root. */
  | "workspace-path"
  /** Exact path relative to the source's own collection root. */
  | "collection-path"
  /** The only file (or path suffix) with that name in the workspace. */
  | "exact-name"
  /** Won over other same-named files by folder or depth tie-break. */
  | "tie-break"
  /** No file matched; frontmatter title inside the source collection. */
  | "title";

export interface WorkspaceCandidate {
  id: number;
  docid: string;
  collection: string;
  /** Workspace-relative path (NFC, original case). */
  path: string;
}

export interface WorkspaceLinkSource {
  collection: string;
  relPath: string;
}

export interface WorkspaceTargetResolution {
  target: WorkspaceCandidate;
  reason: WorkspaceResolutionReason;
  /** False when candidates stay tied: audit-only, never a graph edge. */
  traversable: boolean;
  /** Distinct equally ranked candidates (length > 1 only when tied). */
  tied: WorkspaceCandidate[];
  /** Legacy-compatible rank for title fallback confidence (1-4), else null. */
  titleRank: number | null;
}

interface CatalogDoc extends WorkspaceCandidate {
  wsKey: string;
  /** Workspace-relative path, ASCII-lowered like SQLite lower(). */
  wsNorm: string;
  wsFolderNorm: string;
  depth: number;
  /** Collection-relative path, ASCII-lowered. */
  relNorm: string;
  baseNorm: string;
  titleNorm: string | null;
}

interface CatalogRow {
  id: number;
  docid: string;
  collection: string;
  rel_path: string;
  title_norm: string | null;
}

const RELATIVE_TARGET = /^\.\.?\//;

/** SQLite `lower()` folds ASCII letters only; mirror it exactly. */
const asciiLower = (value: string): string =>
  value.replace(/[A-Z]+/g, (match) => match.toLowerCase());

const lastSegment = (value: string): string =>
  value.slice(value.lastIndexOf("/") + 1);

const folderOf = (value: string): string =>
  value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : "";

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Read every collection's stored link workspace membership. */
export const loadLinkWorkspaceMemberships = (
  db: Database
): Map<string, CollectionWorkspaceMembership> => {
  const rows = db
    .query<
      {
        name: string;
        real_path: string | null;
        workspace_root: string | null;
        workspace_source: LinkWorkspaceSource | null;
        workspace_nested: string | null;
      },
      []
    >(
      "SELECT name, real_path, workspace_root, workspace_source, workspace_nested FROM collections"
    )
    .all();
  const memberships = new Map<string, CollectionWorkspaceMembership>();
  for (const row of rows) {
    let nested: string[] = [];
    if (row.workspace_nested) {
      try {
        const parsed: unknown = JSON.parse(row.workspace_nested);
        if (Array.isArray(parsed)) {
          nested = parsed.filter(
            (value): value is string => typeof value === "string"
          );
        }
      } catch {
        nested = [];
      }
    }
    memberships.set(row.name, {
      collection: row.name,
      realPath: row.real_path,
      root: row.workspace_root,
      source: row.workspace_source ?? "none",
      nested,
    });
  }
  return memberships;
};

/** Workspace identity of a source document, or null for legacy resolution. */
export const workspaceKeyForDocument = (
  memberships: ReadonlyMap<string, CollectionWorkspaceMembership>,
  collection: string,
  relPath: string
): string | null => placeDocument(memberships.get(collection), relPath).key;

/** Collections that can hold documents of the given workspace. */
export const workspaceMemberCollections = (
  memberships: ReadonlyMap<string, CollectionWorkspaceMembership>,
  wsKeys: ReadonlySet<string>
): string[] => {
  const members: string[] = [];
  for (const membership of memberships.values()) {
    const placement = placeDocument(membership, "x");
    const nestedKeys = membership.nested.map(
      (prefix) => placeDocument(membership, `${prefix}/x`).key
    );
    if (
      (placement.key !== null && wsKeys.has(placement.key)) ||
      nestedKeys.some((key) => key !== null && wsKeys.has(key))
    ) {
      members.push(membership.collection);
    }
  }
  return members.sort();
};

/**
 * Normalize a lowercased wiki target for workspace matching. `./` and `../`
 * resolve against the source folder; `..` never escapes the workspace root.
 * Returns null for an escaping target.
 */
export const normalizeWorkspaceTarget = (
  targetRefNorm: string,
  sourceFolderNorm: string
): string | null => {
  let value = targetRefNorm.trim().replace(/^\/+/, "");
  if (value.startsWith("./") || value.startsWith("../")) {
    value = sourceFolderNorm ? `${sourceFolderNorm}/${value}` : value;
  }
  if (value.includes("/") || value === "..") {
    value = pathPosix.normalize(value).replace(/\/+$/, "");
  }
  if (value === ".." || value.startsWith("../") || value === ".") return null;
  return value;
};

/** Keys a document's lowered basename must equal for a target's last segment. */
const basenameKeys = (normalizedTarget: string): string[] => {
  const base = stripWikiMdExt(lastSegment(normalizedTarget));
  return [base, `${base}.md`];
};

/** Legacy title lookup values (ranks 1-4 of the collection-scoped resolver). */
const titleLookups = (targetRefNorm: string): Array<[number, string[]]> => {
  const baseRef = stripWikiMdExt(targetRefNorm);
  const baseRefMd = `${baseRef}.md`;
  const suffixes = (value: string): string[] => {
    const output = [value];
    let separator = value.indexOf("/");
    while (separator >= 0) {
      const suffix = value.slice(separator + 1);
      if (suffix) output.push(suffix);
      separator = value.indexOf("/", separator + 1);
    }
    return output;
  };
  return [
    [1, [baseRef]],
    [2, [baseRefMd]],
    [3, suffixes(baseRef)],
    [
      4,
      suffixes(baseRefMd)
        .filter((value) => value.endsWith(".md"))
        .map((value) => value.slice(0, -3)),
    ],
  ];
};

class WorkspaceCatalog {
  private readonly byBase = new Map<string, CatalogDoc[]>();
  private readonly byTitle = new Map<string, CatalogDoc[]>();

  constructor(
    private readonly memberships: ReadonlyMap<
      string,
      CollectionWorkspaceMembership
    >
  ) {}

  add(row: CatalogRow): void {
    const placement = placeDocument(
      this.memberships.get(row.collection),
      row.rel_path
    );
    if (placement.key === null) return;
    const wsNorm = asciiLower(placement.path);
    const doc: CatalogDoc = {
      id: row.id,
      docid: row.docid,
      collection: row.collection,
      path: placement.path,
      wsKey: placement.key,
      wsNorm,
      wsFolderNorm: folderOf(wsNorm),
      depth: wsNorm.split("/").length,
      relNorm: asciiLower(row.rel_path.normalize("NFC")),
      baseNorm: lastSegment(wsNorm),
      titleNorm: row.title_norm,
    };
    const baseKey = `${doc.wsKey}\0${doc.baseNorm}`;
    const bases = this.byBase.get(baseKey) ?? [];
    bases.push(doc);
    this.byBase.set(baseKey, bases);
    if (doc.titleNorm !== null) {
      const titleKey = `${doc.collection}\0${doc.titleNorm}`;
      const titles = this.byTitle.get(titleKey) ?? [];
      titles.push(doc);
      this.byTitle.set(titleKey, titles);
    }
  }

  byBasename(wsKey: string, keys: readonly string[]): CatalogDoc[] {
    const lists = keys
      .map((key) => this.byBase.get(`${wsKey}\0${key}`))
      .filter((list): list is CatalogDoc[] => list !== undefined);
    if (lists.length <= 1) return lists[0] ?? [];
    const found = new Map<number, CatalogDoc>();
    for (const list of lists) {
      for (const doc of list) found.set(doc.id, doc);
    }
    return [...found.values()];
  }

  byTitleIn(
    collection: string,
    wsKey: string,
    keys: readonly string[]
  ): CatalogDoc[] {
    const found = new Map<number, CatalogDoc>();
    for (const key of keys) {
      for (const doc of this.byTitle.get(`${collection}\0${key}`) ?? []) {
        if (doc.wsKey === wsKey) found.set(doc.id, doc);
      }
    }
    return [...found.values()];
  }
}

interface RankedCandidate {
  doc: CatalogDoc;
  klass: number;
}

/**
 * Collapse rows of one physical source (the same workspace path indexed by
 * overlapping collections). The representative keeps the best class, then
 * the source's own collection, then the lexicographically first collection.
 */
const distinctSources = (
  ranked: RankedCandidate[],
  sourceCollection: string
): RankedCandidate[] => {
  const preference = (left: RankedCandidate, right: RankedCandidate): number =>
    left.klass - right.klass ||
    Number(left.doc.collection !== sourceCollection) -
      Number(right.doc.collection !== sourceCollection) ||
    compareCodeUnits(left.doc.collection, right.doc.collection);
  const bySource = new Map<string, RankedCandidate>();
  for (const candidate of ranked) {
    const key = `${candidate.doc.wsKey}\0${candidate.doc.wsNorm}`;
    const existing = bySource.get(key);
    if (!existing || preference(candidate, existing) < 0) {
      bySource.set(key, candidate);
    }
  }
  return [...bySource.values()];
};

const toCandidate = (doc: CatalogDoc): WorkspaceCandidate => ({
  id: doc.id,
  docid: doc.docid,
  collection: doc.collection,
  path: doc.path,
});

/**
 * Rank one plain wiki target inside its source's workspace. Ranking tuple:
 * workspace-path exact, collection-path exact, same-folder name, other name
 * or path-suffix match; then fewest path segments; candidates still equal
 * are tied (listed in canonical path order, no edge).
 */
const rankTarget = (
  catalog: WorkspaceCatalog,
  wsKey: string,
  source: { collection: string; wsFolderNorm: string },
  targetRefNorm: string
): WorkspaceTargetResolution | null => {
  const normalized = normalizeWorkspaceTarget(
    targetRefNorm,
    source.wsFolderNorm
  );
  if (normalized === null || normalized.length === 0) return null;
  const base = stripWikiMdExt(normalized);
  const exact = new Set([base, `${base}.md`]);
  // A relative target stays a path even when it normalizes to a root name.
  const relative = RELATIVE_TARGET.test(targetRefNorm.trim());
  const hasPath = relative || normalized.includes("/");
  const matches: RankedCandidate[] = [];
  for (const doc of catalog.byBasename(wsKey, basenameKeys(normalized))) {
    let klass: number | null = null;
    // Exact path classes apply to path targets only; a plain name ranks by
    // folder and depth like any other same-named file. A relative target is
    // already a full workspace path: only the exact workspace path matches.
    if (hasPath && exact.has(doc.wsNorm)) klass = 0;
    else if (relative) klass = null;
    else if (
      hasPath &&
      doc.collection === source.collection &&
      exact.has(doc.relNorm)
    ) {
      klass = 1;
    } else if (
      !hasPath ||
      doc.wsNorm.endsWith(`/${base}`) ||
      doc.wsNorm.endsWith(`/${base}.md`)
    ) {
      klass = doc.wsFolderNorm === source.wsFolderNorm ? 2 : 3;
    }
    if (klass !== null) matches.push({ doc, klass });
  }
  const distinct = distinctSources(matches, source.collection);
  if (distinct.length > 0) {
    distinct.sort(
      (left, right) =>
        left.klass - right.klass ||
        left.doc.depth - right.doc.depth ||
        compareCodeUnits(left.doc.wsNorm, right.doc.wsNorm) ||
        compareCodeUnits(left.doc.path, right.doc.path)
    );
    const best = distinct[0]!;
    const tied = distinct.filter(
      (candidate) =>
        candidate.klass === best.klass && candidate.doc.depth === best.doc.depth
    );
    const traversable = tied.length === 1;
    const reason: WorkspaceResolutionReason =
      best.klass === 0
        ? "workspace-path"
        : best.klass === 1
          ? "collection-path"
          : distinct.length === 1
            ? "exact-name"
            : "tie-break";
    return {
      target: toCandidate(best.doc),
      reason,
      traversable,
      tied: traversable ? [] : tied.map(({ doc }) => toCandidate(doc)),
      titleRank: null,
    };
  }
  // Fallback: frontmatter title inside the source collection only; relative
  // targets are paths and never fall back to titles.
  if (relative) return null;
  for (const [rank, keys] of titleLookups(targetRefNorm)) {
    const docs = catalog
      .byTitleIn(source.collection, wsKey, keys)
      .sort(
        (left, right) =>
          left.depth - right.depth ||
          compareCodeUnits(left.wsNorm, right.wsNorm)
      );
    if (docs.length === 0) continue;
    return {
      target: toCandidate(docs[0]!),
      reason: "title",
      traversable: docs.length === 1,
      tied: docs.length === 1 ? [] : docs.map(toCandidate),
      titleRank: rank,
    };
  }
  return null;
};

/** Membership map from collection rows (as returned by getCollections). */
export const membershipsFromCollectionRows = (
  rows: ReadonlyArray<{
    name: string;
    realPath?: string | null;
    workspaceRoot?: string | null;
    workspaceSource?: LinkWorkspaceSource;
    workspaceNested?: string[];
  }>
): Map<string, CollectionWorkspaceMembership> =>
  new Map(
    rows.map((row) => [
      row.name,
      {
        collection: row.name,
        realPath: row.realPath ?? null,
        root: row.workspaceRoot ?? null,
        source: row.workspaceSource ?? "none",
        nested: row.workspaceNested ?? [],
      },
    ])
  );

/**
 * Same ranking over an in-memory document list (graph projection). Returns
 * `undefined` when the source is not in a link workspace (caller keeps its
 * collection-scoped contract), `null` when nothing matched.
 */
export const createInMemoryWorkspaceResolver = (
  memberships: ReadonlyMap<string, CollectionWorkspaceMembership>,
  documents: ReadonlyArray<{
    id: number;
    docid: string;
    collection: string;
    relPath: string;
    title: string | null;
  }>
): ((
  source: WorkspaceLinkSource,
  targetRefNorm: string
) => WorkspaceTargetResolution | null | undefined) => {
  const anyWorkspace = [...memberships.values()].some(
    (membership) =>
      membership.realPath !== null &&
      membership.source !== "disabled" &&
      membership.source !== "unavailable" &&
      (membership.root !== null || membership.nested.length > 0)
  );
  if (!anyWorkspace) return () => undefined;
  const catalog = new WorkspaceCatalog(memberships);
  for (const document of documents) {
    catalog.add({
      id: document.id,
      docid: document.docid,
      collection: document.collection,
      rel_path: document.relPath,
      // Mirrors SQLite lower(trim(title)) used by the SQL candidate paths.
      title_norm:
        typeof document.title === "string"
          ? asciiLower(document.title.trim())
          : null,
    });
  }
  return (source, targetRefNorm) => {
    const placement = placeDocument(
      memberships.get(source.collection),
      source.relPath
    );
    if (placement.key === null) return undefined;
    return rankTarget(
      catalog,
      placement.key,
      {
        collection: source.collection,
        wsFolderNorm: folderOf(asciiLower(placement.path)),
      },
      targetRefNorm
    );
  };
};

export interface WorkspaceTargetInput {
  targetRefNorm: string;
  source: WorkspaceLinkSource;
  wsKey: string;
}

const MAX_SQL_PARAMS = 900;
const CATALOG_COLUMNS =
  "id, docid, collection, rel_path, lower(trim(title)) AS title_norm";
/** SQLite basename of rel_path (text after the last '/'). */
const BASENAME_SQL =
  "substr(rel_path, length(rtrim(rel_path, replace(rel_path, '/', ''))) + 1)";

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push(items.slice(offset, offset + size));
  }
  return chunks;
};

const loadRows = (
  db: Database,
  collections: readonly string[],
  filter: { sql: string; values: string[] } | null
): CatalogRow[] => {
  if (collections.length === 0) return [];
  const rows: CatalogRow[] = [];
  const collectionPlaceholders = collections.map(() => "?").join(",");
  const valueChunks = filter
    ? chunk(filter.values, Math.max(1, MAX_SQL_PARAMS - collections.length))
    : [[]];
  for (const values of valueChunks) {
    if (filter && values.length === 0) continue;
    rows.push(
      ...db
        .query<CatalogRow, string[]>(
          `SELECT ${CATALOG_COLUMNS} FROM documents
           WHERE active = 1 AND collection IN (${collectionPlaceholders})
           ${filter ? `AND ${filter.sql} IN (${values.map(() => "?").join(",")})` : ""}
           ORDER BY id`
        )
        .all(...collections, ...values)
    );
  }
  return rows;
};

/** Both Unicode forms so a NFD file name still reaches the NFC ranking. */
const withUnicodeForms = (values: Iterable<string>): string[] => {
  const output = new Set<string>();
  for (const value of values) {
    output.add(value);
    output.add(value.normalize("NFD"));
  }
  return [...output].sort();
};

/**
 * Resolve workspace targets. `bulk` loads every document of the involved
 * workspaces once; otherwise a SQL basename/title prefilter fetches only
 * potential candidates. Both paths rank identical rows identically.
 */
export const resolveWorkspaceTargets = (
  db: Database,
  memberships: ReadonlyMap<string, CollectionWorkspaceMembership>,
  targets: readonly WorkspaceTargetInput[],
  options: { bulk: boolean }
): Array<WorkspaceTargetResolution | null> => {
  if (targets.length === 0) return [];
  const wsKeys = new Set(targets.map((target) => target.wsKey));
  const collections = workspaceMemberCollections(memberships, wsKeys);
  const catalog = new WorkspaceCatalog(memberships);
  const seen = new Set<number>();
  const addRows = (rows: CatalogRow[]) => {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      catalog.add(row);
    }
  };
  if (options.bulk) {
    addRows(loadRows(db, collections, null));
  } else {
    const bases = new Set<string>();
    const titles = new Set<string>();
    for (const target of targets) {
      const normalized = normalizeWorkspaceTarget(target.targetRefNorm, "");
      const raw = target.targetRefNorm.trim();
      for (const value of [normalized, raw]) {
        if (!value) continue;
        for (const key of basenameKeys(value)) bases.add(key);
      }
      for (const [, keys] of titleLookups(target.targetRefNorm)) {
        for (const key of keys) titles.add(key);
      }
    }
    addRows(
      loadRows(db, collections, {
        sql: `lower(${BASENAME_SQL})`,
        values: withUnicodeForms(bases),
      })
    );
    addRows(
      loadRows(db, collections, {
        sql: "lower(trim(title))",
        values: [...titles].sort(),
      })
    );
  }
  const cache = new Map<string, WorkspaceTargetResolution | null>();
  const folders = new Map<string, string>();
  return targets.map((target) => {
    const sourceKey = `${target.source.collection}\0${target.source.relPath}`;
    let wsFolderNorm = folders.get(sourceKey);
    if (wsFolderNorm === undefined) {
      wsFolderNorm = folderOf(
        asciiLower(
          placeDocument(
            memberships.get(target.source.collection),
            target.source.relPath
          ).path
        )
      );
      folders.set(sourceKey, wsFolderNorm);
    }
    // Resolution depends on workspace, source collection and folder only.
    const cacheKey = `${target.wsKey}\0${target.source.collection}\0${wsFolderNorm}\0${target.targetRefNorm}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;
    const result = rankTarget(
      catalog,
      target.wsKey,
      { collection: target.source.collection, wsFolderNorm },
      target.targetRefNorm
    );
    cache.set(cacheKey, result);
    return result;
  });
};
