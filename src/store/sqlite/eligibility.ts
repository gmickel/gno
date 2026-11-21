import type { Database } from "bun:sqlite";

import type { DocumentEligibilityOptions } from "../types";

import { TYPED_METADATA_INGEST_VERSION } from "../../core/typed-metadata";
import { compileMetadataPredicate } from "./metadata-predicate";

function containsLowerTerm(haystack: string, lowerTerms: string[]): boolean {
  if (!haystack) return false;
  const lowered = haystack.toLowerCase();
  for (const term of lowerTerms) {
    if (lowered.includes(term)) return true;
  }
  return false;
}

/** Unbounded owner selection; compose with FTS rowids or chunk mirror ownership
 * before ranking/LIMIT. EXISTS keeps multiple tags/scopes from duplicating owners.
 * Retains store filter semantics; lexical runtime language remains reserved. */
export function buildEligibleDocumentQuery(
  options: DocumentEligibilityOptions,
  db?: Database
): { sql: string; params: (string | number)[] } {
  // Build tag filter conditions using EXISTS subqueries
  const conditions: string[] = ["d.active = 1"];
  const params: (string | number)[] = [];
  if (options.filter) {
    const predicate = compileMetadataPredicate(options.filter);
    conditions.push(
      "d.ingest_version >= ?",
      "d.metadata_error IS NULL",
      "d.typed_metadata IS NOT NULL",
      predicate.sql
    );
    params.push(TYPED_METADATA_INGEST_VERSION, ...predicate.params);
  }
  if (options.chunkLanguage) {
    conditions.push(
      "EXISTS (SELECT 1 FROM content_chunks lc WHERE lc.mirror_hash = d.mirror_hash AND lc.language = ?)"
    );
    params.push(options.chunkLanguage);
  }

  // tagsAny: document has at least one of these tags
  if (options.tagsAny && options.tagsAny.length > 0) {
    conditions.push(
      "EXISTS (SELECT 1 FROM doc_tags dt WHERE dt.document_id = d.id AND dt.tag IN (SELECT value FROM json_each(?)))"
    );
    params.push(JSON.stringify(options.tagsAny));
  }

  // tagsAll: document has all of these tags
  if (options.tagsAll && options.tagsAll.length > 0) {
    for (const tag of options.tagsAll) {
      conditions.push(
        "EXISTS (SELECT 1 FROM doc_tags dt WHERE dt.document_id = d.id AND dt.tag = ?)"
      );
      params.push(tag);
    }
  }

  if (options.since) {
    conditions.push("d.source_mtime >= ?");
    params.push(options.since);
  }
  if (options.until) {
    conditions.push("d.source_mtime <= ?");
    params.push(options.until);
  }
  if (
    !options.semanticMetadata &&
    options.categories &&
    options.categories.length > 0
  ) {
    const categoriesJson = JSON.stringify(options.categories);
    conditions.push(
      "(d.content_type IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM json_each(COALESCE(d.categories, '[]')) jc WHERE jc.value IN (SELECT value FROM json_each(?))))"
    );
    params.push(categoriesJson, categoriesJson);
  }
  if (!options.semanticMetadata && options.author) {
    conditions.push("LOWER(COALESCE(d.author, '')) LIKE ?");
    params.push(`%${options.author.toLowerCase()}%`);
  }

  // Without planner statistics a collection filter can outrank the hash
  // index; a hash allowlist is always the selective predicate.
  const hashPin =
    options.allowedMirrorHashes === undefined
      ? ""
      : " INDEXED BY idx_documents_mirror_hash";
  if (options.allowedMirrorHashes !== undefined) {
    conditions.push("d.mirror_hash IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(options.allowedMirrorHashes));
  }
  if (options.collection) {
    conditions.push("d.collection = ?");
    params.push(options.collection);
  }
  if (options.collections !== undefined) {
    conditions.push("d.collection IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(options.collections));
  }
  if (options.relPathPrefix !== undefined) {
    conditions.push(
      "(COALESCE(NULLIF(d.record_source_path, ''), d.rel_path) = ? OR substr(COALESCE(NULLIF(d.record_source_path, ''), d.rel_path), 1, length(?) + 1) = ? || '/')"
    );
    params.push(
      options.relPathPrefix,
      options.relPathPrefix,
      options.relPathPrefix
    );
  }
  if (options.memoryScopesAny?.length) {
    conditions.push(
      "EXISTS (SELECT 1 FROM doc_memory_scopes ms WHERE ms.document_id = d.id AND ms.scope IN (SELECT value FROM json_each(?)))"
    );
    params.push(JSON.stringify(options.memoryScopesAny));
  }
  if (options.excludeSuperseded) {
    conditions.push(
      "NOT EXISTS (SELECT 1 FROM doc_edges se JOIN documents sd ON sd.id = se.src_doc_id AND sd.active = 1 WHERE se.dst_doc_id = d.id AND se.edge_type = 'supersedes')"
    );
  }
  const hasExclude = Boolean(options.exclude?.length);
  if (
    hasExclude ||
    (options.semanticMetadata && (options.author || options.categories?.length))
  ) {
    if (!db)
      throw new Error("Exclusion eligibility requires document metadata");
    const lowerAuthor = options.author?.toLowerCase();
    const wantedCategories = options.categories?.length
      ? new Set(options.categories.map((value) => value.toLowerCase()))
      : null;
    const lowerExcludes = hasExclude
      ? options.exclude!.map((term) => term.toLowerCase())
      : null;
    const needsCategories = Boolean(
      options.semanticMetadata || options.excludeMetadata
    );

    // Omit content_chunks join when no text exclusions are requested; check
    // document-level metadata once per document and short-circuit denied docs.
    const sql = hasExclude
      ? `SELECT d.id, d.title, d.author, d.content_type, d.categories, COALESCE(d.record_source_path, d.rel_path) AS path, cc.text
         FROM documents d${hashPin} LEFT JOIN content_chunks cc ON cc.mirror_hash = d.mirror_hash
         WHERE ${conditions.join(" AND ")}`
      : `SELECT d.id, d.title, d.author, d.content_type, d.categories, COALESCE(d.record_source_path, d.rel_path) AS path, NULL AS text
         FROM documents d${hashPin}
         WHERE ${conditions.join(" AND ")}`;

    const stmt = db.prepare<
      {
        id: number;
        title: string | null;
        path: string;
        text: string | null;
        author: string | null;
        content_type: string | null;
        categories: string | null;
      },
      (string | number)[]
    >(sql);
    const denied = new Set<number>();
    const checkedDocs = new Set<number>();
    try {
      for (const row of stmt.iterate(...params)) {
        if (denied.has(row.id)) continue;
        if (!checkedDocs.has(row.id)) {
          checkedDocs.add(row.id);
          let categories: string[] = [];
          if (needsCategories) {
            const parsed: unknown = JSON.parse(row.categories ?? "[]");
            if (
              !Array.isArray(parsed) ||
              !parsed.every(
                (value): value is string => typeof value === "string"
              )
            ) {
              denied.add(row.id);
              continue;
            }
            categories = parsed;
          }
          if (options.semanticMetadata) {
            if (
              (lowerAuthor &&
                !(row.author ?? "").toLowerCase().includes(lowerAuthor)) ||
              (wantedCategories &&
                !wantedCategories.has((row.content_type ?? "").toLowerCase()) &&
                !categories.some((value) =>
                  wantedCategories.has(value.toLowerCase())
                ))
            ) {
              denied.add(row.id);
              continue;
            }
          }
          if (lowerExcludes) {
            if (
              containsLowerTerm(row.title ?? "", lowerExcludes) ||
              containsLowerTerm(row.path, lowerExcludes) ||
              (options.excludeMetadata &&
                (containsLowerTerm(row.author ?? "", lowerExcludes) ||
                  containsLowerTerm(row.content_type ?? "", lowerExcludes) ||
                  categories.some((cat) =>
                    containsLowerTerm(cat, lowerExcludes)
                  )))
            ) {
              denied.add(row.id);
              continue;
            }
          }
        }
        if (
          lowerExcludes &&
          row.text &&
          containsLowerTerm(row.text, lowerExcludes)
        ) {
          denied.add(row.id);
        }
      }
    } finally {
      stmt.finalize();
    }
    if (denied.size > 0) {
      conditions.push("d.id NOT IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify([...denied]));
    }
  }
  return {
    sql: `SELECT d.id, d.mirror_hash FROM documents d${hashPin} WHERE ${conditions.join(" AND ")}`,
    params,
  };
}
