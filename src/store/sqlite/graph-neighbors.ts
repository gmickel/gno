/**
 * Seed-scoped one-hop graph neighbor resolution for query-time expansion.
 * Avoids collection-wide getGraph correlated link resolution.
 *
 * Resolution and scope are separate steps: links resolve with the shared
 * workspace-aware resolver, then the collection allowlist is applied to the
 * resolved source AND target of every edge before scoring or limits, so a
 * cross-collection edge never widens the caller's scope.
 *
 * @module src/store/sqlite/graph-neighbors
 */

import type { Database } from "bun:sqlite";

import type {
  GetGraphNeighborsOptions,
  GraphEdgeAudit,
  GraphEdgeConfidence,
  GraphLink,
  GraphLinkType,
  GraphNeighborsResult,
} from "../types";

import {
  classifyResolvedGraphEdge,
  mergeGraphEdgeAudit,
} from "../../core/graph-edge-confidence";
import { normalizeWikiName, stripWikiMdExt } from "../../core/links";
import {
  isTraversableResolution,
  linkSourceIdentity,
  resolveGraphLinkTargets,
} from "./graph-link-resolver";
import {
  loadLinkWorkspaceMemberships,
  workspaceKeyForDocument,
  workspaceMemberCollections,
} from "./workspace-link-resolver";

const MAX_SEED_DOCUMENTS = 5;
const DEFAULT_EDGE_LIMIT = 10_000;

interface SeedDocRow {
  id: number;
  docid: string;
  title: string | null;
  rel_path: string;
  collection: string;
}

interface ResolvedEdgeRow {
  source_docid: string;
  target_docid: string;
  link_type: "wiki" | "markdown";
  match_rank: number | null;
  match_count: number | null;
  reason?: string;
}

interface RawLinkRow {
  id: number;
  source_docid: string;
  source_collection: string;
  source_rel_path: string;
  target_ref_norm: string;
  target_collection: string | null;
  link_type: "wiki" | "markdown";
}

const RAW_LINK_COLUMNS = `dl.id, src.docid AS source_docid,
  src.collection AS source_collection, src.rel_path AS source_rel_path,
  dl.target_ref_norm, dl.target_collection, dl.link_type`;

const addWikiKeyVariants = (keySet: Set<string>, value: string): void => {
  if (!value) {
    return;
  }
  const base = stripWikiMdExt(value);
  const md = `${base}.md`;
  keySet.add(value);
  keySet.add(base);
  keySet.add(md);
};

const wikiKeysForSeed = (seed: SeedDocRow): Set<string> => {
  const keySet = new Set<string>();
  addWikiKeyVariants(keySet, normalizeWikiName(seed.title ?? ""));
  const relPathKey = normalizeWikiName(seed.rel_path);
  addWikiKeyVariants(keySet, relPathKey);
  const basename = relPathKey.split("/").pop() ?? relPathKey;
  if (basename !== relPathKey) {
    addWikiKeyVariants(keySet, basename);
  }
  return keySet;
};

const matchesWikiKey = (targetRefNorm: string, keys: Set<string>): boolean => {
  for (const key of keys) {
    if (targetRefNorm === key || targetRefNorm.endsWith(`/${key}`)) {
      return true;
    }
  }
  return false;
};

const escapeLike = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

/** Effective graph allowlist; undefined means unrestricted. */
export const graphCollectionAllowlist = (options: {
  collection?: string;
  collections?: string[];
}): Set<string> | undefined => {
  if (options.collections) return new Set(options.collections);
  if (options.collection) return new Set([options.collection]);
  return undefined;
};

const inScopeClause = (
  allowlist: Set<string> | undefined,
  column: string
): { sql: string; params: string[] } =>
  allowlist
    ? {
        sql:
          allowlist.size === 0
            ? "AND 0"
            : `AND ${column} IN (${[...allowlist].map(() => "?").join(",")})`,
        params: [...allowlist],
      }
    : { sql: "", params: [] };

const loadSeeds = (db: Database, seedDocumentIds: number[]): SeedDocRow[] => {
  const uniqueIds = [...new Set(seedDocumentIds)]
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, MAX_SEED_DOCUMENTS);
  if (uniqueIds.length === 0) {
    return [];
  }
  const placeholders = uniqueIds.map(() => "?").join(",");
  return db
    .query<SeedDocRow, number[]>(
      `SELECT id, docid, title, rel_path, collection
       FROM documents
       WHERE active = 1 AND id IN (${placeholders})
       ORDER BY id ASC`
    )
    .all(...uniqueIds);
};

const collectIncomingCandidateLinks = (
  db: Database,
  seeds: SeedDocRow[],
  allowlist: Set<string> | undefined
): { links: RawLinkRow[]; examinedLinkRows: number } => {
  const linksById = new Map<number, RawLinkRow>();
  let examinedLinkRows = 0;
  const seedIdSet = new Set(seeds.map((seed) => seed.id));
  const sourceScope = inScopeClause(allowlist, "src.collection");

  const wikiKeysByCollection = new Map<string, Set<string>>();
  for (const seed of seeds) {
    const keys = wikiKeysByCollection.get(seed.collection) ?? new Set<string>();
    for (const key of wikiKeysForSeed(seed)) {
      keys.add(key);
    }
    wikiKeysByCollection.set(seed.collection, keys);
  }

  const targetCollections = [...wikiKeysByCollection.keys()];
  if (targetCollections.length > 0) {
    const collectionPlaceholders = targetCollections.map(() => "?").join(",");
    const wikiRows = db
      .query<RawLinkRow & { source_doc_id: number }, string[]>(
        `SELECT dl.source_doc_id, ${RAW_LINK_COLUMNS}
         FROM doc_links dl
         JOIN documents src ON src.id = dl.source_doc_id AND src.active = 1
         WHERE dl.link_type = 'wiki'
           AND (
             (dl.target_collection IS NULL
               AND src.collection IN (${collectionPlaceholders}))
             OR dl.target_collection IN (${collectionPlaceholders})
           )
           ${sourceScope.sql}`
      )
      .all(...targetCollections, ...targetCollections, ...sourceScope.params);
    examinedLinkRows += wikiRows.length;

    for (const row of wikiRows) {
      const targetCollection = row.target_collection ?? row.source_collection;
      const keys = wikiKeysByCollection.get(targetCollection);
      if (
        keys &&
        !seedIdSet.has(row.source_doc_id) &&
        matchesWikiKey(row.target_ref_norm, keys)
      ) {
        linksById.set(row.id, row);
      }
    }
  }

  // Workspace seeds: plain links from any member collection whose last path
  // segment names the seed file. The resolver decides which really land on
  // the seed; this only bounds the candidate rows.
  const memberships = loadLinkWorkspaceMemberships(db);
  const workspaceSeeds = seeds
    .map((seed) => ({
      seed,
      wsKey: workspaceKeyForDocument(
        memberships,
        seed.collection,
        seed.rel_path
      ),
    }))
    .filter(
      (entry): entry is { seed: SeedDocRow; wsKey: string } =>
        entry.wsKey !== null
    );
  if (workspaceSeeds.length > 0) {
    const members = workspaceMemberCollections(
      memberships,
      new Set(workspaceSeeds.map(({ wsKey }) => wsKey))
    );
    const conditions: string[] = [];
    const params: string[] = [];
    for (const { seed } of workspaceSeeds) {
      const base = stripWikiMdExt(
        normalizeWikiName(seed.rel_path.split("/").pop() ?? seed.rel_path)
      );
      for (const value of [base, `${base}.md`]) {
        conditions.push(
          "dl.target_ref_norm = ? OR dl.target_ref_norm LIKE ? ESCAPE '\\'"
        );
        params.push(value, `%/${escapeLike(value)}`);
      }
      for (const key of wikiKeysForSeed(seed)) {
        conditions.push("dl.target_ref_norm = ?");
        params.push(key);
      }
    }
    if (members.length > 0 && conditions.length > 0) {
      const rows = db
        .query<RawLinkRow & { source_doc_id: number }, string[]>(
          `SELECT dl.source_doc_id, ${RAW_LINK_COLUMNS}
           FROM doc_links dl
           JOIN documents src ON src.id = dl.source_doc_id AND src.active = 1
           WHERE dl.link_type = 'wiki'
             AND dl.target_collection IS NULL
             AND src.collection IN (${members.map(() => "?").join(",")})
             AND (${conditions.join(" OR ")})
             ${sourceScope.sql}`
        )
        .all(...members, ...params, ...sourceScope.params);
      examinedLinkRows += rows.length;
      for (const row of rows) {
        if (!seedIdSet.has(row.source_doc_id)) linksById.set(row.id, row);
      }
    }
  }

  for (const seed of seeds) {
    const mdRows = db
      .query<RawLinkRow & { source_doc_id: number }, string[]>(
        `SELECT dl.source_doc_id, ${RAW_LINK_COLUMNS}
         FROM doc_links dl
         JOIN documents src ON src.id = dl.source_doc_id AND src.active = 1
         WHERE dl.link_type = 'markdown'
           AND dl.target_ref_norm = ?
           AND (
             (dl.target_collection IS NULL AND src.collection = ?)
             OR dl.target_collection = ?
           )
           ${sourceScope.sql}`
      )
      .all(
        seed.rel_path,
        seed.collection,
        seed.collection,
        ...sourceScope.params
      );
    examinedLinkRows += mdRows.length;
    for (const row of mdRows) {
      if (!seedIdSet.has(row.source_doc_id)) {
        linksById.set(row.id, row);
      }
    }
  }

  return { links: [...linksById.values()], examinedLinkRows };
};

const loadRawLinksForSources = (
  db: Database,
  sourceIds: number[],
  allowlist: Set<string> | undefined
): RawLinkRow[] => {
  if (sourceIds.length === 0) {
    return [];
  }
  const sourcePlaceholders = sourceIds.map(() => "?").join(",");
  const sourceScope = inScopeClause(allowlist, "src.collection");
  return db
    .query<RawLinkRow, (string | number)[]>(
      `SELECT ${RAW_LINK_COLUMNS}
       FROM documents src
       JOIN doc_links dl ON dl.source_doc_id = src.id
       WHERE src.active = 1
         AND src.id IN (${sourcePlaceholders})
         ${sourceScope.sql}
       ORDER BY src.id ASC, dl.id ASC`
    )
    .all(...sourceIds, ...sourceScope.params);
};

const resolveRawEdges = (
  db: Database,
  rawRows: RawLinkRow[],
  incomingLinkIds: Set<number>,
  seedIds: Set<number>,
  allowlist: Set<string> | undefined
): ResolvedEdgeRow[] => {
  const resolvedTargets = resolveGraphLinkTargets(
    db,
    rawRows.map((row) => ({
      targetRefNorm: row.target_ref_norm,
      targetCollection: row.target_collection ?? row.source_collection,
      linkType: row.link_type,
      source: linkSourceIdentity(row),
    }))
  );
  const rows: ResolvedEdgeRow[] = [];
  for (const [index, rawRow] of rawRows.entries()) {
    const target = resolvedTargets[index];
    if (
      !isTraversableResolution(target) ||
      (incomingLinkIds.has(rawRow.id) && !seedIds.has(target.targetId))
    ) {
      continue;
    }
    // Scope applies to the resolved identities, never the declared prefix.
    if (
      allowlist &&
      (!allowlist.has(rawRow.source_collection) ||
        !allowlist.has(
          target.targetCollection ??
            rawRow.target_collection ??
            rawRow.source_collection
        ))
    ) {
      continue;
    }
    rows.push({
      source_docid: rawRow.source_docid,
      target_docid: target.targetDocid,
      link_type: rawRow.link_type,
      match_rank: target.matchRank,
      match_count: target.matchCount,
      reason: target.reason,
    });
  }
  return rows;
};

const toGraphLinks = (
  rows: ResolvedEdgeRow[],
  limitEdges: number
): GraphLink[] => {
  const edgeMap = new Map<
    string,
    {
      type: GraphLinkType;
      weight: number;
      confidence: GraphEdgeConfidence;
      audit: GraphEdgeAudit;
    }
  >();

  for (const row of rows) {
    const key = `${row.source_docid}:${row.target_docid}:${row.link_type}`;
    const { confidence, audit } = classifyResolvedGraphEdge(
      row.link_type,
      row.match_rank,
      row.match_count,
      row.reason
    );
    const existing = edgeMap.get(key);
    if (existing) {
      existing.weight += 1;
      mergeGraphEdgeAudit(existing, confidence, audit);
    } else {
      edgeMap.set(key, {
        type: row.link_type,
        weight: 1,
        confidence,
        audit,
      });
    }
  }

  return [...edgeMap.entries()]
    .map(([key, val]) => {
      const parts = key.split(":");
      return {
        source: parts[0] ?? "",
        target: parts[1] ?? "",
        type: val.type,
        weight: val.weight,
        confidence: val.confidence,
        audit: val.audit,
      };
    })
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.target.localeCompare(right.target) ||
        left.type.localeCompare(right.type)
    )
    .slice(0, limitEdges);
};

/**
 * Resolve one-hop explicit/inferred/ambiguous neighbors for a small seed set.
 * Does not compute similarity edges (vector retrieval already supplies those).
 */
export function queryGraphNeighborsForSeeds(
  db: Database,
  options: GetGraphNeighborsOptions
): GraphNeighborsResult {
  const limitEdges = Math.max(
    1,
    Math.min(50_000, options.limitEdges ?? DEFAULT_EDGE_LIMIT)
  );
  const allowlist = graphCollectionAllowlist(options);
  const seeds = loadSeeds(db, options.seedDocumentIds).filter(
    (seed) => !allowlist || allowlist.has(seed.collection)
  );
  if (seeds.length === 0) {
    return {
      links: [],
      meta: {
        seedDocumentIds: [],
        examinedLinkRows: 0,
        returnedEdges: 0,
      },
    };
  }

  const seedIds = seeds.map((seed) => seed.id);
  const outgoingLinks = loadRawLinksForSources(db, seedIds, allowlist);
  const { links: incomingLinks, examinedLinkRows: incomingCandidates } =
    collectIncomingCandidateLinks(db, seeds, allowlist);
  const incomingLinkIds = new Set(incomingLinks.map((link) => link.id));
  const rawLinksById = new Map(
    [...outgoingLinks, ...incomingLinks].map((link) => [link.id, link])
  );
  const resolvedRows = resolveRawEdges(
    db,
    [...rawLinksById.values()],
    incomingLinkIds,
    new Set(seedIds),
    allowlist
  );

  const examinedLinkRows = outgoingLinks.length + incomingCandidates;
  const links = toGraphLinks(resolvedRows, limitEdges);

  return {
    links,
    meta: {
      seedDocumentIds: seedIds,
      examinedLinkRows,
      returnedEdges: links.length,
    },
  };
}
