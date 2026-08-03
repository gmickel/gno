/**
 * Batched wiki/markdown target resolution for seed-scoped graph expansion.
 *
 * @module src/store/sqlite/graph-link-resolver
 */

import type { Database } from "bun:sqlite";

import { stripWikiMdExt } from "../../core/links";
import { resolveGraphLinkTargetsBulk } from "./graph-link-bulk-resolver";

export interface GraphLinkTarget {
  targetRefNorm: string;
  targetCollection: string;
  linkType: "wiki" | "markdown";
}

export interface ResolvedGraphLinkTarget {
  targetId: number;
  targetDocid: string;
  matchRank: number;
  matchCount: number;
}

const MAX_SQL_PARAMS = 900;
const BULK_RESOLUTION_THRESHOLD = 128;
export const AUDIT_LINK_SNAPSHOT_MAX_DOCUMENTS = 50_000;
export const AUDIT_LINK_SNAPSHOT_MAX_LINKS = 50_000;

export interface AuditLinkSnapshotDocument {
  id: number;
  docid: string;
  uri: string;
  collection: string;
  relPath: string;
  recordSourcePath: string | null;
  title: string | null;
  mirrorHash: string | null;
}

export interface AuditLinkSnapshotLink {
  sourceId: number;
  sourceDocid: string;
  sourceUri: string;
  sourceCollection: string;
  sourceRelPath: string;
  targetRef: string;
  targetRefNorm: string;
  targetAnchor: string | null;
  targetCollection: string;
  linkType: "wiki" | "markdown";
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  resolved: ResolvedGraphLinkTarget | null;
}

export interface AuditLinkSnapshot {
  documents: AuditLinkSnapshotDocument[];
  /** Optional finding scope when documents also include graph-wide evidence. */
  auditedDocumentIds?: number[];
  links: AuditLinkSnapshotLink[];
  totals: { documents: number; links: number };
  truncated: { documents: boolean; links: boolean };
  metrics: {
    documentRowsExamined: number;
    linkRowsExamined: number;
    uniqueTargetsResolved: number;
    batchedResolution: true;
  };
}

export interface AuditLinkSnapshotOptions {
  collections?: readonly string[];
  pathPrefixes?: readonly string[];
  maxDocuments?: number;
  maxLinks?: number;
}

const chunkArray = <T>(items: T[], chunkSize: number): T[][] => {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += chunkSize) {
    chunks.push(items.slice(offset, offset + chunkSize));
  }
  return chunks;
};

const suffixMatch = (targetExpr: string, valueExpr: string): string =>
  `(substr(${targetExpr}, -length(${valueExpr})) = ${valueExpr}
    AND (length(${targetExpr}) = length(${valueExpr})
      OR substr(${targetExpr}, -length(${valueExpr}) - 1, 1) = '/'))`;

export const resolveGraphLinkTargetsSql = (
  db: Database,
  targets: GraphLinkTarget[]
): Array<ResolvedGraphLinkTarget | null> => {
  const results: Array<ResolvedGraphLinkTarget | null> = Array.from(
    { length: targets.length },
    () => null
  );
  const wikiTargets: Array<{
    idx: number;
    collection: string;
    baseRef: string;
    baseRefMd: string;
  }> = [];
  const markdownTargets: Array<{
    idx: number;
    collection: string;
    relPath: string;
  }> = [];

  for (const [idx, target] of targets.entries()) {
    if (target.linkType === "wiki") {
      const baseRef = stripWikiMdExt(target.targetRefNorm);
      wikiTargets.push({
        idx,
        collection: target.targetCollection,
        baseRef,
        baseRefMd: `${baseRef}.md`,
      });
    } else {
      markdownTargets.push({
        idx,
        collection: target.targetCollection,
        relPath: target.targetRefNorm,
      });
    }
  }

  const titleExpr = "lower(trim(d.title))";
  const relExpr = "lower(d.rel_path)";
  const baseRefExpr = "t.base_ref";
  const baseRefMdExpr = "t.base_ref_md";
  const wikiWhere = `
    ${titleExpr} = ${baseRefExpr}
    OR ${titleExpr} = ${baseRefMdExpr}
    OR ${suffixMatch(baseRefExpr, titleExpr)}
    OR ${suffixMatch(baseRefMdExpr, `${titleExpr} || '.md'`)}
    OR ${relExpr} = ${baseRefExpr}
    OR ${relExpr} = ${baseRefMdExpr}
    OR ${suffixMatch(relExpr, baseRefMdExpr)}
    OR ${suffixMatch(relExpr, baseRefExpr)}
    OR ${suffixMatch(baseRefMdExpr, relExpr)}
    OR ${suffixMatch(baseRefExpr, relExpr)}
  `;
  const wikiRank = `CASE
    WHEN ${titleExpr} = ${baseRefExpr} THEN 1
    WHEN ${titleExpr} = ${baseRefMdExpr} THEN 2
    WHEN ${suffixMatch(baseRefExpr, titleExpr)} THEN 3
    WHEN ${suffixMatch(baseRefMdExpr, `${titleExpr} || '.md'`)} THEN 4
    WHEN ${relExpr} = ${baseRefExpr} THEN 5
    WHEN ${relExpr} = ${baseRefMdExpr} THEN 6
    WHEN ${suffixMatch(relExpr, baseRefMdExpr)} THEN 7
    WHEN ${suffixMatch(relExpr, baseRefExpr)} THEN 8
    WHEN ${suffixMatch(baseRefMdExpr, relExpr)} THEN 9
    WHEN ${suffixMatch(baseRefExpr, relExpr)} THEN 10
    ELSE 99
  END`;

  const wikiBatchSize = Math.max(1, Math.floor(MAX_SQL_PARAMS / 4));
  for (const batch of chunkArray(wikiTargets, wikiBatchSize)) {
    const valuesClause = batch.map(() => "(?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((target) => [
      target.idx,
      target.collection,
      target.baseRef,
      target.baseRefMd,
    ]);
    const rows = db
      .query<
        {
          idx: number;
          target_id: number;
          target_docid: string;
          match_rank: number;
          match_count: number;
        },
        (string | number)[]
      >(
        `WITH targets(idx, collection, base_ref, base_ref_md) AS (
           VALUES ${valuesClause}
         ),
         candidates AS (
           SELECT t.idx, d.id AS target_id, d.docid AS target_docid,
             ${wikiRank} AS match_rank
           FROM targets t
           JOIN documents d ON d.active = 1 AND d.collection = t.collection
           WHERE ${wikiWhere}
         ),
         best_candidates AS (
           SELECT candidates.*
           FROM candidates
           JOIN (
             SELECT idx, MIN(match_rank) AS best_rank
             FROM candidates
             GROUP BY idx
           ) best
             ON best.idx = candidates.idx
            AND best.best_rank = candidates.match_rank
         ),
         ranked AS (
           SELECT *,
             COUNT(*) OVER (PARTITION BY idx) AS match_count,
             ROW_NUMBER() OVER (PARTITION BY idx ORDER BY target_id) AS rn
           FROM best_candidates
         )
         SELECT idx, target_id, target_docid, match_rank, match_count
         FROM ranked
         WHERE rn = 1`
      )
      .all(...params);

    for (const row of rows) {
      results[row.idx] = {
        targetId: row.target_id,
        targetDocid: row.target_docid,
        matchRank: row.match_rank,
        matchCount: row.match_count,
      };
    }
  }

  const markdownBatchSize = Math.max(1, Math.floor(MAX_SQL_PARAMS / 3));
  for (const batch of chunkArray(markdownTargets, markdownBatchSize)) {
    const valuesClause = batch.map(() => "(?, ?, ?)").join(", ");
    const params = batch.flatMap((target) => [
      target.idx,
      target.collection,
      target.relPath,
    ]);
    const rows = db
      .query<
        { idx: number; target_id: number; target_docid: string },
        (string | number)[]
      >(
        `WITH targets(idx, collection, rel_path) AS (
           VALUES ${valuesClause}
         ),
         ranked AS (
           SELECT t.idx, d.id AS target_id, d.docid AS target_docid,
             ROW_NUMBER() OVER (PARTITION BY t.idx ORDER BY d.id) AS rn
           FROM targets t
           JOIN documents d ON d.active = 1
             AND d.collection = t.collection
             AND d.rel_path = t.rel_path
         )
         SELECT idx, target_id, target_docid
         FROM ranked
         WHERE rn = 1`
      )
      .all(...params);

    for (const row of rows) {
      results[row.idx] = {
        targetId: row.target_id,
        targetDocid: row.target_docid,
        matchRank: 5,
        matchCount: 1,
      };
    }
  }

  return results;
};

/** Resolve all targets in bounded SQL batches while retaining confidence inputs. */
export function resolveGraphLinkTargets(
  db: Database,
  targets: GraphLinkTarget[]
): Array<ResolvedGraphLinkTarget | null> {
  const uniqueTargets: GraphLinkTarget[] = [];
  const uniqueIndexByKey = new Map<string, number>();
  const originalToUniqueIndex: number[] = [];

  for (const target of targets) {
    const key = JSON.stringify([
      target.linkType,
      target.targetCollection,
      target.targetRefNorm,
    ]);
    let uniqueIndex = uniqueIndexByKey.get(key);
    if (uniqueIndex === undefined) {
      uniqueIndex = uniqueTargets.length;
      uniqueIndexByKey.set(key, uniqueIndex);
      uniqueTargets.push(target);
    }
    originalToUniqueIndex.push(uniqueIndex);
  }

  if (uniqueTargets.length > BULK_RESOLUTION_THRESHOLD) {
    const bulkResults = resolveGraphLinkTargetsBulk(db, uniqueTargets);
    if (bulkResults) {
      return originalToUniqueIndex.map(
        (uniqueIndex) => bulkResults[uniqueIndex] ?? null
      );
    }
  }

  const uniqueResults = resolveGraphLinkTargetsSql(db, uniqueTargets);
  return originalToUniqueIndex.map(
    (uniqueIndex) => uniqueResults[uniqueIndex] ?? null
  );
}

/**
 * Capture one bounded, read-only link inventory using set-oriented SQL and the
 * same target resolver as graph expansion. No query is issued per finding.
 */
export function captureAuditLinkSnapshot(
  db: Database,
  options: AuditLinkSnapshotOptions = {}
): AuditLinkSnapshot {
  const maxDocuments = Math.max(
    1,
    Math.min(
      AUDIT_LINK_SNAPSHOT_MAX_DOCUMENTS,
      options.maxDocuments ?? AUDIT_LINK_SNAPSHOT_MAX_DOCUMENTS
    )
  );
  const maxLinks = Math.max(
    1,
    Math.min(
      AUDIT_LINK_SNAPSHOT_MAX_LINKS,
      options.maxLinks ?? AUDIT_LINK_SNAPSHOT_MAX_LINKS
    )
  );
  const conditions = ["d.active = 1"];
  const params: string[] = [];
  const collections = [...new Set(options.collections ?? [])]
    .map((value) => value.normalize("NFC").trim())
    .filter(Boolean)
    .sort();
  if (collections.length > 0) {
    conditions.push(
      `d.collection IN (${collections.map(() => "?").join(",")})`
    );
    params.push(...collections);
  }
  const prefixes = [...new Set(options.pathPrefixes ?? [])]
    .map((value) => value.normalize("NFC").trim().replace(/^\/+/, ""))
    .filter(Boolean)
    .sort();
  if (prefixes.length > 0) {
    conditions.push(
      `(${prefixes.map(() => "COALESCE(NULLIF(d.record_source_path, ''), d.rel_path) = ? OR COALESCE(NULLIF(d.record_source_path, ''), d.rel_path) LIKE ? ESCAPE '\\'").join(" OR ")})`
    );
    for (const prefix of prefixes) {
      const escaped = prefix
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_");
      params.push(prefix, `${escaped}/%`);
    }
  }
  const where = conditions.join(" AND ");
  const totalDocuments =
    db
      .query<{ count: number }, string[]>(
        `SELECT COUNT(*) AS count FROM documents d WHERE ${where}`
      )
      .get(...params)?.count ?? 0;
  const documentRows = db
    .query<
      {
        id: number;
        docid: string;
        uri: string;
        collection: string;
        rel_path: string;
        record_source_path: string | null;
        title: string | null;
        mirror_hash: string | null;
      },
      (string | number)[]
    >(
      `SELECT d.id, d.docid, d.uri, d.collection, d.rel_path, d.record_source_path, d.title, d.mirror_hash
       FROM documents d WHERE ${where} ORDER BY d.id LIMIT ?`
    )
    .all(...params, maxDocuments);
  const totalLinks =
    db
      .query<{ count: number }, string[]>(
        `SELECT COUNT(*) AS count
         FROM doc_links dl
         JOIN documents d ON d.id = dl.source_doc_id
         WHERE ${where} AND dl.source = 'parsed'`
      )
      .get(...params)?.count ?? 0;
  const rawLinks = db
    .query<
      {
        source_id: number;
        source_docid: string;
        source_uri: string;
        source_collection: string;
        source_rel_path: string;
        target_ref: string;
        target_ref_norm: string;
        target_anchor: string | null;
        target_collection: string | null;
        link_type: "wiki" | "markdown";
        start_line: number;
        start_col: number;
        end_line: number;
        end_col: number;
      },
      (string | number)[]
    >(
      `SELECT d.id AS source_id, d.docid AS source_docid,
              d.uri AS source_uri, d.collection AS source_collection,
              COALESCE(NULLIF(d.record_source_path, ''), d.rel_path) AS source_rel_path, dl.target_ref,
              dl.target_ref_norm, dl.target_anchor, dl.target_collection,
              dl.link_type, dl.start_line, dl.start_col,
              dl.end_line, dl.end_col
       FROM doc_links dl
       JOIN documents d ON d.id = dl.source_doc_id
       WHERE ${where} AND dl.source = 'parsed'
       ORDER BY d.id, dl.start_line, dl.start_col, dl.id
       LIMIT ?`
    )
    .all(...params, maxLinks);
  const targets = rawLinks.map((row) => ({
    targetRefNorm: row.target_ref_norm,
    targetCollection: row.target_collection ?? row.source_collection,
    linkType: row.link_type,
  }));
  const resolutions = resolveGraphLinkTargets(db, targets);
  const uniqueTargetsResolved = new Set(
    targets.map((target) =>
      JSON.stringify([
        target.linkType,
        target.targetCollection,
        target.targetRefNorm,
      ])
    )
  ).size;

  return {
    documents: documentRows.map((row) => ({
      id: row.id,
      docid: row.docid,
      uri: row.uri,
      collection: row.collection,
      relPath: row.rel_path,
      recordSourcePath: row.record_source_path,
      title: row.title,
      mirrorHash: row.mirror_hash,
    })),
    links: rawLinks.map((row, index) => ({
      sourceId: row.source_id,
      sourceDocid: row.source_docid,
      sourceUri: row.source_uri,
      sourceCollection: row.source_collection,
      sourceRelPath: row.source_rel_path,
      targetRef: row.target_ref,
      targetRefNorm: row.target_ref_norm,
      targetAnchor: row.target_anchor,
      targetCollection: row.target_collection ?? row.source_collection,
      linkType: row.link_type,
      startLine: row.start_line,
      startCol: row.start_col,
      endLine: row.end_line,
      endCol: row.end_col,
      resolved: resolutions[index] ?? null,
    })),
    totals: { documents: totalDocuments, links: totalLinks },
    truncated: {
      documents: totalDocuments > documentRows.length,
      links: totalLinks > rawLinks.length,
    },
    metrics: {
      documentRowsExamined: documentRows.length,
      linkRowsExamined: rawLinks.length,
      uniqueTargetsResolved,
      batchedResolution: true,
    },
  };
}
