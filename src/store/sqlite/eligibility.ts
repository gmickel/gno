import type { Database } from "bun:sqlite";

import type { DocumentEligibilityOptions } from "../types";

import { matchesExcludedText } from "../../pipeline/exclude";

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
  if (options.chunkLanguage) {
    conditions.push(
      "EXISTS (SELECT 1 FROM content_chunks lc WHERE lc.mirror_hash = d.mirror_hash AND lc.language = ?)"
    );
    params.push(options.chunkLanguage);
  }

  // tagsAny: document has at least one of these tags
  if (options.tagsAny && options.tagsAny.length > 0) {
    const placeholders = options.tagsAny.map(() => "?").join(",");
    conditions.push(
      `EXISTS (SELECT 1 FROM doc_tags dt WHERE dt.document_id = d.id AND dt.tag IN (${placeholders}))`
    );
    params.push(...options.tagsAny);
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
    const placeholders = options.categories.map(() => "?").join(",");
    conditions.push(
      `(d.content_type IN (${placeholders}) OR EXISTS (SELECT 1 FROM json_each(COALESCE(d.categories, '[]')) jc WHERE jc.value IN (${placeholders})))`
    );
    params.push(...options.categories, ...options.categories);
  }
  if (!options.semanticMetadata && options.author) {
    conditions.push("LOWER(COALESCE(d.author, '')) LIKE ?");
    params.push(`%${options.author.toLowerCase()}%`);
  }

  if (options.allowedMirrorHashes !== undefined) {
    conditions.push("d.mirror_hash IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(options.allowedMirrorHashes));
  }
  if (options.collection) {
    conditions.push("d.collection = ?");
    params.push(options.collection);
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
    const placeholders = options.memoryScopesAny.map(() => "?").join(",");
    conditions.push(
      `EXISTS (SELECT 1 FROM doc_memory_scopes ms WHERE ms.document_id = d.id AND ms.scope IN (${placeholders}))`
    );
    params.push(...options.memoryScopesAny);
  }
  if (options.excludeSuperseded) {
    conditions.push(
      "NOT EXISTS (SELECT 1 FROM doc_edges se JOIN documents sd ON sd.id = se.src_doc_id AND sd.active = 1 WHERE se.dst_doc_id = d.id AND se.edge_type = 'supersedes')"
    );
  }
  if (
    options.exclude?.length ||
    (options.semanticMetadata && (options.author || options.categories?.length))
  ) {
    if (!db)
      throw new Error("Exclusion eligibility requires document metadata");
    // One bulk read, preserving JavaScript Unicode case folding and exclusions
    // across every chunk, including chunks outside a later language selection.
    const rows = db
      .query<
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
      >(`
      SELECT d.id, d.title, d.author, d.content_type, d.categories, COALESCE(d.record_source_path, d.rel_path) AS path, cc.text
      FROM documents d LEFT JOIN content_chunks cc ON cc.mirror_hash = d.mirror_hash
      WHERE ${conditions.join(" AND ")}
    `)
      .iterate(...params);
    const denied = new Set<number>();
    for (const row of rows) {
      const categories: unknown =
        options.semanticMetadata || options.excludeMetadata
          ? JSON.parse(row.categories ?? "[]")
          : [];
      if (
        !Array.isArray(categories) ||
        !categories.every((value): value is string => typeof value === "string")
      ) {
        denied.add(row.id);
        continue;
      }
      if (options.semanticMetadata) {
        const wanted = options.categories?.map((value) => value.toLowerCase());
        if (
          (options.author &&
            !(row.author ?? "")
              .toLowerCase()
              .includes(options.author.toLowerCase())) ||
          (wanted?.length &&
            ![row.content_type ?? "", ...categories].some((value) =>
              wanted.includes(value.toLowerCase())
            ))
        ) {
          denied.add(row.id);
          continue;
        }
      }
      if (
        matchesExcludedText(
          [
            row.title ?? "",
            row.path,
            row.text ?? "",
            ...(options.excludeMetadata
              ? [row.author ?? "", row.content_type ?? "", ...categories]
              : []),
          ],
          options.exclude ?? []
        )
      )
        denied.add(row.id);
    }
    conditions.push("d.id NOT IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify([...denied]));
  }
  return {
    sql: `SELECT d.id, d.mirror_hash FROM documents d WHERE ${conditions.join(" AND ")}`,
    params,
  };
}
