import type { Database } from "bun:sqlite";

import type { VectorSearchOptions } from "./types";

import { buildEligibleDocumentQuery } from "../sqlite/eligibility";

/** Correlated canonical chunk domain; owner predicates stay in the shared builder. */
export function buildEligibleVectorQuery(
  db: Database,
  options: VectorSearchOptions
): { sql: string; params: (string | number)[] } {
  const eligibility = options.eligibility ?? {};
  const owners = buildEligibleDocumentQuery(
    { ...eligibility, semanticMetadata: true },
    db
  );
  const conditions = [
    "cc.mirror_hash = v.mirror_hash",
    "cc.seq = v.seq",
    `cc.mirror_hash IN (SELECT mirror_hash FROM (${owners.sql}))`,
  ];
  const params = [...owners.params];
  if (eligibility.language) {
    conditions.push("cc.language = ?");
    params.push(eligibility.language);
  }
  // Caller scope intersects owner scope; an explicitly empty array denies all.
  if (options.allowedMirrorHashes !== undefined) {
    conditions.push("cc.mirror_hash IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(options.allowedMirrorHashes));
  }
  return {
    sql: `SELECT 1 FROM content_chunks cc WHERE ${conditions.join(" AND ")}`,
    params,
  };
}

/**
 * Set-driven eligible `(mirror_hash, seq)` domain for legacy vector search:
 * deduplicates eligible `mirror_hash`es first and joins into `content_chunks`
 * and `content_vectors` by key instead of scanning every vector row.
 */
export function buildEligibleVectorChunksQuery(
  db: Database,
  options: VectorSearchOptions
): { sql: string; params: (string | number)[] } {
  const eligibility = options.eligibility ?? {};
  const owners = buildEligibleDocumentQuery(
    { ...eligibility, semanticMetadata: true },
    db
  );
  const mirrorConditions: string[] = [];
  const params: (string | number)[] = [...owners.params];
  if (options.allowedMirrorHashes !== undefined) {
    mirrorConditions.push("em.mirror_hash IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(options.allowedMirrorHashes));
  }
  const chunkConditions: string[] = [];
  if (eligibility.language) {
    chunkConditions.push("cc.language = ?");
    params.push(eligibility.language);
  }
  const mirrorFilter = mirrorConditions.length
    ? ` AND ${mirrorConditions.join(" AND ")}`
    : "";
  const chunkWhere = chunkConditions.length
    ? ` WHERE ${chunkConditions.join(" AND ")}`
    : "";
  return {
    sql: `SELECT cc.mirror_hash, cc.seq
      FROM (SELECT DISTINCT mirror_hash FROM (${owners.sql})) em
      JOIN content_chunks cc ON cc.mirror_hash = em.mirror_hash${mirrorFilter}${chunkWhere}`,
    params,
  };
}
