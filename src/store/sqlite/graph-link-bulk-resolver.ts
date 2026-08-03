/** Linear-time bulk target resolution for large graph-link inventories. */

import type { Database } from "bun:sqlite";

import type {
  GraphLinkTarget,
  ResolvedGraphLinkTarget,
} from "./graph-link-resolver";

import { stripWikiMdExt } from "../../core/links";

interface IndexedDocument {
  id: number;
  docid: string;
  collection: string;
  titleNorm: string | null;
  relNorm: string;
  relRaw: string;
}

type Lookup = Map<string, IndexedDocument[]>;

export const GRAPH_LINK_BULK_MAX_DOCUMENTS = 100_000;

const lookupKey = (collection: string, value: string): string =>
  `${collection}\0${value}`;

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

const appendLookup = (
  lookup: Lookup,
  collection: string,
  value: string,
  document: IndexedDocument
): void => {
  const key = lookupKey(collection, value);
  const documents = lookup.get(key) ?? [];
  documents.push(document);
  lookup.set(key, documents);
};

const candidatesFor = (
  lookup: Lookup,
  collection: string,
  values: readonly string[]
): IndexedDocument[] => {
  const byId = new Map<number, IndexedDocument>();
  for (const value of values) {
    for (const document of lookup.get(lookupKey(collection, value)) ?? []) {
      byId.set(document.id, document);
    }
  }
  return [...byId.values()].sort((left, right) => left.id - right.id);
};

const resolved = (
  documents: readonly IndexedDocument[],
  matchRank: number
): ResolvedGraphLinkTarget | null => {
  const first = documents[0];
  if (!first) return null;
  return {
    targetId: first.id,
    targetDocid: first.docid,
    matchRank,
    matchCount: documents.length,
  };
};

/**
 * Resolve a large target set with lookup tables equivalent to the ranked SQL
 * resolver. SQLite still performs lower()/trim(), preserving its normalization
 * semantics; resolution then scales with documents plus path segments.
 */
export const resolveGraphLinkTargetsBulk = (
  db: Database,
  targets: readonly GraphLinkTarget[],
  maxDocuments = GRAPH_LINK_BULK_MAX_DOCUMENTS
): Array<ResolvedGraphLinkTarget | null> | null => {
  const boundedMaxDocuments = Math.max(
    1,
    Math.min(GRAPH_LINK_BULK_MAX_DOCUMENTS, maxDocuments)
  );
  const rows = db
    .query<
      {
        id: number;
        docid: string;
        collection: string;
        title_norm: string | null;
        rel_norm: string;
        rel_raw: string;
      },
      [number]
    >(
      `SELECT id, docid, collection, lower(trim(title)) AS title_norm,
              lower(rel_path) AS rel_norm, rel_path AS rel_raw
       FROM documents
       WHERE active = 1
       ORDER BY id
       LIMIT ?`
    )
    .all(boundedMaxDocuments + 1);
  // The fast lookup-table path is intentionally bounded. Callers fall back to
  // set-oriented SQL batches when the active index exceeds this memory cap.
  if (rows.length > boundedMaxDocuments) return null;
  const titleExact: Lookup = new Map();
  const relExact: Lookup = new Map();
  const relExactRaw: Lookup = new Map();
  const relSuffix: Lookup = new Map();
  for (const row of rows) {
    const document: IndexedDocument = {
      id: row.id,
      docid: row.docid,
      collection: row.collection,
      titleNorm: row.title_norm,
      relNorm: row.rel_norm,
      relRaw: row.rel_raw,
    };
    if (document.titleNorm !== null) {
      appendLookup(titleExact, row.collection, document.titleNorm, document);
    }
    appendLookup(relExact, row.collection, document.relNorm, document);
    appendLookup(relExactRaw, row.collection, document.relRaw, document);
    for (const suffix of suffixes(document.relNorm)) {
      appendLookup(relSuffix, row.collection, suffix, document);
    }
  }

  const cache = new Map<string, ResolvedGraphLinkTarget | null>();
  return targets.map((target) => {
    const cacheKey = JSON.stringify([
      target.linkType,
      target.targetCollection,
      target.targetRefNorm,
    ]);
    if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;
    let result: ResolvedGraphLinkTarget | null;
    if (target.linkType === "markdown") {
      result = resolved(
        candidatesFor(relExactRaw, target.targetCollection, [
          target.targetRefNorm,
        ]),
        5
      );
    } else {
      const baseRef = stripWikiMdExt(target.targetRefNorm);
      const baseRefMd = `${baseRef}.md`;
      const rankedCandidates: Array<[number, Lookup, string[]]> = [
        [1, titleExact, [baseRef]],
        [2, titleExact, [baseRefMd]],
        [3, titleExact, suffixes(baseRef)],
        [
          4,
          titleExact,
          suffixes(baseRefMd)
            .filter((value) => value.endsWith(".md"))
            .map((value) => value.slice(0, -3)),
        ],
        [5, relExact, [baseRef]],
        [6, relExact, [baseRefMd]],
        [7, relSuffix, [baseRefMd]],
        [8, relSuffix, [baseRef]],
        [9, relExact, suffixes(baseRefMd)],
        [10, relExact, suffixes(baseRef)],
      ];
      result = null;
      for (const [rank, lookup, values] of rankedCandidates) {
        const documents = candidatesFor(
          lookup,
          target.targetCollection,
          values
        );
        if (documents.length === 0) continue;
        result = resolved(documents, rank);
        break;
      }
    }
    cache.set(cacheKey, result);
    return result;
  });
};
