/**
 * Batched wiki/markdown target resolution for seed-scoped graph expansion.
 *
 * @module src/store/sqlite/graph-link-resolver
 */

import type { Database } from "bun:sqlite";

import { stripWikiMdExt } from "../../core/links";

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

const resolveUniqueGraphLinkTargets = (
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

  const uniqueResults = resolveUniqueGraphLinkTargets(db, uniqueTargets);
  return originalToUniqueIndex.map(
    (uniqueIndex) => uniqueResults[uniqueIndex] ?? null
  );
}
