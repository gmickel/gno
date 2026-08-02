/**
 * Seed-scoped one-hop graph neighbor resolution for query-time expansion.
 * Avoids collection-wide getGraph correlated link resolution.
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
import { resolveGraphLinkTargets } from "./graph-link-resolver";

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
}

interface RawLinkRow {
  id: number;
  source_docid: string;
  source_collection: string;
  target_ref_norm: string;
  target_collection: string | null;
  link_type: "wiki" | "markdown";
}

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
  collection: string | undefined
): { links: RawLinkRow[]; examinedLinkRows: number } => {
  const linksById = new Map<number, RawLinkRow>();
  let examinedLinkRows = 0;
  const seedIdSet = new Set(seeds.map((seed) => seed.id));

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
        `SELECT dl.id, dl.source_doc_id, src.docid AS source_docid,
           src.collection AS source_collection, dl.target_ref_norm,
           dl.target_collection, dl.link_type
         FROM doc_links dl
         JOIN documents src ON src.id = dl.source_doc_id AND src.active = 1
         WHERE dl.link_type = 'wiki'
           AND (
             (dl.target_collection IS NULL
               AND src.collection IN (${collectionPlaceholders}))
             OR dl.target_collection IN (${collectionPlaceholders})
           )
           ${collection ? "AND src.collection = ?" : ""}`
      )
      .all(
        ...targetCollections,
        ...targetCollections,
        ...(collection ? [collection] : [])
      );
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

  for (const seed of seeds) {
    const mdRows = db
      .query<RawLinkRow & { source_doc_id: number }, string[]>(
        `SELECT dl.id, dl.source_doc_id, src.docid AS source_docid,
           src.collection AS source_collection, dl.target_ref_norm,
           dl.target_collection, dl.link_type
         FROM doc_links dl
         JOIN documents src ON src.id = dl.source_doc_id AND src.active = 1
         WHERE dl.link_type = 'markdown'
           AND dl.target_ref_norm = ?
           AND (
             (dl.target_collection IS NULL AND src.collection = ?)
             OR dl.target_collection = ?
           )
           ${collection ? "AND src.collection = ?" : ""}`
      )
      .all(
        seed.rel_path,
        seed.collection,
        seed.collection,
        ...(collection ? [collection] : [])
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
  collection: string | undefined
): RawLinkRow[] => {
  if (sourceIds.length === 0) {
    return [];
  }
  const sourcePlaceholders = sourceIds.map(() => "?").join(",");
  const params: (string | number)[] = [...sourceIds];
  if (collection) {
    params.push(collection);
  }
  return db
    .query<RawLinkRow, (string | number)[]>(
      `SELECT dl.id, src.docid AS source_docid,
         src.collection AS source_collection,
         dl.target_ref_norm, dl.target_collection, dl.link_type
       FROM documents src
       JOIN doc_links dl ON dl.source_doc_id = src.id
       WHERE src.active = 1
         AND src.id IN (${sourcePlaceholders})
         ${collection ? "AND src.collection = ?" : ""}
       ORDER BY src.id ASC, dl.id ASC`
    )
    .all(...params);
};

const resolveRawEdges = (
  db: Database,
  rawRows: RawLinkRow[],
  incomingLinkIds: Set<number>,
  seedIds: Set<number>,
  collection: string | undefined
): ResolvedEdgeRow[] => {
  const inScopeRows = rawRows.filter(
    (row) =>
      !collection ||
      (row.target_collection ?? row.source_collection) === collection
  );
  const resolvedTargets = resolveGraphLinkTargets(
    db,
    inScopeRows.map((row) => ({
      targetRefNorm: row.target_ref_norm,
      targetCollection: row.target_collection ?? row.source_collection,
      linkType: row.link_type,
    }))
  );
  const rows: ResolvedEdgeRow[] = [];
  for (const [index, rawRow] of inScopeRows.entries()) {
    const target = resolvedTargets[index];
    if (
      !target ||
      (incomingLinkIds.has(rawRow.id) && !seedIds.has(target.targetId))
    ) {
      continue;
    }
    rows.push({
      source_docid: rawRow.source_docid,
      target_docid: target.targetDocid,
      link_type: rawRow.link_type,
      match_rank: target.matchRank,
      match_count: target.matchCount,
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
      row.match_count
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
  const seeds = loadSeeds(db, options.seedDocumentIds);
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
  const outgoingLinks = loadRawLinksForSources(db, seedIds, options.collection);
  const { links: incomingLinks, examinedLinkRows: incomingCandidates } =
    collectIncomingCandidateLinks(db, seeds, options.collection);
  const incomingLinkIds = new Set(incomingLinks.map((link) => link.id));
  const rawLinksById = new Map(
    [...outgoingLinks, ...incomingLinks].map((link) => [link.id, link])
  );
  const resolvedRows = resolveRawEdges(
    db,
    [...rawLinksById.values()],
    incomingLinkIds,
    new Set(seedIds),
    options.collection
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
