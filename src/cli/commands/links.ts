/**
 * gno links, backlinks, and similar command implementations.
 * List document links, backlinks, and semantically similar documents.
 *
 * @module src/cli/commands/links
 */

import { basename } from "node:path";

import type { DocLinkRow, DocumentRow, StorePort } from "../../store/types";

import { normalizeWikiName } from "../../core/links";
import { parseRef } from "./ref-parser";
import { initStore } from "./shared";

// ─────────────────────────────────────────────────────────────────────────────
// Types - Links List
// ─────────────────────────────────────────────────────────────────────────────

export interface LinksListOptions {
  /** Override config path */
  configPath?: string;
  /** Filter by link type */
  type?: "wiki" | "markdown";
  /** JSON output */
  json?: boolean;
  /** Markdown output */
  md?: boolean;
}

export interface LinkWithResolution {
  targetRef: string;
  targetRefNorm: string;
  targetAnchor?: string;
  targetCollection?: string;
  linkType: "wiki" | "markdown";
  linkText?: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  resolved: boolean;
  resolvedDocid?: string;
  resolvedUri?: string;
}

export interface LinksListResponse {
  links: LinkWithResolution[];
  meta: {
    docid: string;
    uri: string;
    title?: string;
    totalLinks: number;
    resolvedCount: number;
    typeFilter?: "wiki" | "markdown";
  };
}

export type LinksListResult =
  | { success: true; data: LinksListResponse }
  | { success: false; error: string; isValidation?: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Types - Backlinks
// ─────────────────────────────────────────────────────────────────────────────

export interface BacklinksOptions {
  /** Override config path */
  configPath?: string;
  /** Filter by collection */
  collection?: string;
  /** JSON output */
  json?: boolean;
  /** Markdown output */
  md?: boolean;
}

export interface BacklinkItem {
  sourceDocid: string;
  sourceUri: string;
  sourceTitle?: string;
  linkText?: string;
  startLine: number;
  startCol: number;
}

export interface BacklinksResponse {
  backlinks: BacklinkItem[];
  meta: {
    docid: string;
    uri: string;
    title?: string;
    totalBacklinks: number;
    collection?: string;
  };
}

export type BacklinksResult =
  | { success: true; data: BacklinksResponse }
  | { success: false; error: string; isValidation?: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Types - Similar
// ─────────────────────────────────────────────────────────────────────────────

export interface SimilarOptions {
  /** Override config path */
  configPath?: string;
  /** Max results */
  limit?: number;
  /** Minimum similarity threshold (0-1) */
  threshold?: number;
  /** Search across all collections */
  crossCollection?: boolean;
  /** JSON output */
  json?: boolean;
  /** Markdown output */
  md?: boolean;
}

export interface SimilarItem {
  docid: string;
  uri: string;
  title?: string;
  score: number;
  collection: string;
  relPath: string;
}

export interface SimilarResponse {
  similar: SimilarItem[];
  meta: {
    docid: string;
    uri: string;
    title?: string;
    totalResults: number;
    limit: number;
    threshold: number;
    crossCollection: boolean;
  };
}

export type SimilarResult =
  | { success: true; data: SimilarResponse }
  | { success: false; error: string; isValidation?: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Resolve document reference (supports all ref formats)
// ─────────────────────────────────────────────────────────────────────────────

async function resolveDocRef(
  store: StorePort,
  docRef: string
): Promise<{ doc: DocumentRow } | { error: string; isValidation: boolean }> {
  // Parse the ref to determine type
  const parsed = parseRef(docRef);

  if ("error" in parsed) {
    return { error: parsed.error, isValidation: true };
  }

  let doc: DocumentRow | null = null;

  switch (parsed.type) {
    case "docid": {
      const result = await store.getDocumentByDocid(parsed.value);
      if (result.ok && result.value) {
        doc = result.value;
      }
      break;
    }
    case "uri": {
      const result = await store.getDocumentByUri(parsed.value);
      if (result.ok && result.value) {
        doc = result.value;
      }
      break;
    }
    case "collPath": {
      // Build URI from collection/path
      const uri = `gno://${parsed.collection}/${parsed.relPath}`;
      const result = await store.getDocumentByUri(uri);
      if (result.ok && result.value) {
        doc = result.value;
      }
      break;
    }
  }

  if (!doc) {
    return { error: `Document not found: ${docRef}`, isValidation: true };
  }

  return { doc };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Build resolution indexes (cached per collection)
// ─────────────────────────────────────────────────────────────────────────────

interface ResolutionIndexes {
  // Map: normalized wiki name -> DocumentRow
  wikiIndex: Map<string, DocumentRow>;
  // Map: relPath -> DocumentRow
  pathIndex: Map<string, DocumentRow>;
}

/** Normalize markdown link path for matching (strip ./, collapse ..) */
function normalizeMarkdownPath(path: string): string {
  // Strip leading ./
  let normalized = path.replace(/^\.\//, "");
  // Collapse simple parent refs (a/b/../c -> a/c)
  while (normalized.includes("/../")) {
    normalized = normalized.replace(/[^/]+\/\.\.\//, "");
  }
  return normalized;
}

async function buildResolutionIndexes(
  store: StorePort,
  collection: string,
  cache: Map<string, ResolutionIndexes>
): Promise<ResolutionIndexes> {
  const cached = cache.get(collection);
  if (cached) {
    return cached;
  }

  const indexes: ResolutionIndexes = {
    wikiIndex: new Map(),
    pathIndex: new Map(),
  };

  const docsResult = await store.listDocuments(collection);
  if (!docsResult.ok) {
    // Collection may not exist or store error - return empty indexes
    // Links to this collection will show as unresolved
    cache.set(collection, indexes);
    return indexes;
  }

  for (const d of docsResult.value) {
    if (!d.active) continue;

    // Index by relPath for markdown links (exact match)
    indexes.pathIndex.set(d.relPath, d);

    // Also index by normalized path (without ./) for common variants
    const normalizedPath = normalizeMarkdownPath(d.relPath);
    if (
      normalizedPath !== d.relPath &&
      !indexes.pathIndex.has(normalizedPath)
    ) {
      indexes.pathIndex.set(normalizedPath, d);
    }

    // Index by normalized title for wiki links
    if (d.title) {
      const wikiKey = normalizeWikiName(d.title);
      indexes.wikiIndex.set(wikiKey, d);
    }

    // Also index by filename stem as fallback for wiki links
    const stem = basename(d.relPath).replace(/\.[^.]+$/, "");
    if (stem) {
      const stemKey = normalizeWikiName(stem);
      // Don't overwrite title match
      if (!indexes.wikiIndex.has(stemKey)) {
        indexes.wikiIndex.set(stemKey, d);
      }
    }
  }

  cache.set(collection, indexes);
  return indexes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Map DocLinkRow to output format (avoids null leakage)
// ─────────────────────────────────────────────────────────────────────────────

function mapLinkToOutput(
  link: DocLinkRow,
  resolved: boolean,
  resolvedDocid?: string,
  resolvedUri?: string
): LinkWithResolution {
  return {
    targetRef: link.targetRef,
    targetRefNorm: link.targetRefNorm,
    // Only include if not null
    ...(link.targetAnchor && { targetAnchor: link.targetAnchor }),
    ...(link.targetCollection && { targetCollection: link.targetCollection }),
    linkType: link.linkType,
    ...(link.linkText && { linkText: link.linkText }),
    startLine: link.startLine,
    startCol: link.startCol,
    endLine: link.endLine,
    endCol: link.endCol,
    resolved,
    ...(resolvedDocid && { resolvedDocid }),
    ...(resolvedUri && { resolvedUri }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Command: links list
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno links [list] command.
 * Lists outgoing links from a document.
 */
export async function linksList(
  docRef: string,
  options: LinksListOptions = {}
): Promise<LinksListResult> {
  const initResult = await initStore({ configPath: options.configPath });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const { store } = initResult;

  try {
    // Resolve document
    const resolved = await resolveDocRef(store, docRef);
    if ("error" in resolved) {
      return {
        success: false,
        error: resolved.error,
        isValidation: resolved.isValidation,
      };
    }
    const { doc } = resolved;

    // Get links
    const linksResult = await store.getLinksForDoc(doc.id);
    if (!linksResult.ok) {
      return { success: false, error: linksResult.error.message };
    }

    let links = linksResult.value;

    // Filter by type if specified
    if (options.type) {
      links = links.filter((l) => l.linkType === options.type);
    }

    // Sort by position for deterministic output
    links.sort((a, b) => {
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return a.startCol - b.startCol;
    });

    // Build resolution indexes (cached per collection)
    const indexCache = new Map<string, ResolutionIndexes>();
    const linksWithResolution: LinkWithResolution[] = [];

    for (const link of links) {
      let resolvedDoc: DocumentRow | undefined;

      // Determine target collection (explicit or same as source)
      const targetCollection = link.targetCollection ?? doc.collection;

      // Get or build index for target collection
      const indexes = await buildResolutionIndexes(
        store,
        targetCollection,
        indexCache
      );

      // Safe fallback for targetRefNorm
      const targetNorm = link.targetRefNorm || link.targetRef;

      if (link.linkType === "wiki") {
        // Wiki links: match by normalized title or filename
        const wikiKey = normalizeWikiName(targetNorm);
        resolvedDoc = indexes.wikiIndex.get(wikiKey);
      } else {
        // Markdown links: match by relPath (try exact, then normalized)
        resolvedDoc = indexes.pathIndex.get(targetNorm);
        if (!resolvedDoc) {
          const normalizedTarget = normalizeMarkdownPath(targetNorm);
          resolvedDoc = indexes.pathIndex.get(normalizedTarget);
        }
      }

      linksWithResolution.push(
        mapLinkToOutput(
          link,
          !!resolvedDoc,
          resolvedDoc?.docid,
          resolvedDoc?.uri
        )
      );
    }

    const resolvedCount = linksWithResolution.filter((l) => l.resolved).length;

    return {
      success: true,
      data: {
        links: linksWithResolution,
        meta: {
          docid: doc.docid,
          uri: doc.uri,
          ...(doc.title && { title: doc.title }),
          totalLinks: linksWithResolution.length,
          resolvedCount,
          ...(options.type && { typeFilter: options.type }),
        },
      },
    };
  } finally {
    await store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command: backlinks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno backlinks command.
 * Lists documents that link TO this document.
 */
export async function backlinks(
  docRef: string,
  options: BacklinksOptions = {}
): Promise<BacklinksResult> {
  const initResult = await initStore({ configPath: options.configPath });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const { store } = initResult;

  try {
    // Resolve document
    const resolved = await resolveDocRef(store, docRef);
    if ("error" in resolved) {
      return {
        success: false,
        error: resolved.error,
        isValidation: resolved.isValidation,
      };
    }
    const { doc } = resolved;

    // Get backlinks
    const backlinksResult = await store.getBacklinksForDoc(doc.id, {
      collection: options.collection,
    });
    if (!backlinksResult.ok) {
      return { success: false, error: backlinksResult.error.message };
    }

    // Convert to response format - sourceDocid already in BacklinkRow
    // Sort by source doc then position for determinism
    const sorted = [...backlinksResult.value].sort((a, b) => {
      if (a.sourceDocUri !== b.sourceDocUri) {
        return a.sourceDocUri.localeCompare(b.sourceDocUri);
      }
      if (a.startLine !== b.startLine) return a.startLine - b.startLine;
      return a.startCol - b.startCol;
    });

    const backlinkItems: BacklinkItem[] = sorted.map((bl) => ({
      sourceDocid: bl.sourceDocid,
      sourceUri: bl.sourceDocUri,
      ...(bl.sourceDocTitle && { sourceTitle: bl.sourceDocTitle }),
      ...(bl.linkText && { linkText: bl.linkText }),
      startLine: bl.startLine,
      startCol: bl.startCol,
    }));

    return {
      success: true,
      data: {
        backlinks: backlinkItems,
        meta: {
          docid: doc.docid,
          uri: doc.uri,
          ...(doc.title && { title: doc.title }),
          totalBacklinks: backlinkItems.length,
          ...(options.collection && { collection: options.collection }),
        },
      },
    };
  } finally {
    await store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Command: similar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno similar command.
 * Finds semantically similar documents using vector embeddings.
 */
export async function similar(
  docRef: string,
  options: SimilarOptions = {}
): Promise<SimilarResult> {
  const limit = options.limit ?? 5;
  const threshold = options.threshold ?? 0.7;
  const crossCollection = options.crossCollection ?? false;

  const initResult = await initStore({ configPath: options.configPath });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const { store, config } = initResult;

  try {
    // Resolve document
    const resolved = await resolveDocRef(store, docRef);
    if ("error" in resolved) {
      return {
        success: false,
        error: resolved.error,
        isValidation: resolved.isValidation,
      };
    }
    const { doc } = resolved;

    if (!doc.mirrorHash) {
      return {
        success: false,
        error: "Document has no content hash - not indexed",
        isValidation: true,
      };
    }

    // Get embedding model config
    const { getActivePreset } = await import("../../llm/registry.js");
    const modelPreset = getActivePreset(config);

    // Get SqliteDbProvider for raw DB access
    const { isSqliteDbProvider } = await import("../../store/sqlite/types.js");
    if (!isSqliteDbProvider(store)) {
      return {
        success: false,
        error: "Vector search requires SQLite store",
      };
    }
    const db = store.getRawDb();

    // Get document embedding from content_vectors (prefer seq=0)
    interface VectorRow {
      embedding: Uint8Array;
    }

    const embedModel = modelPreset.embed;
    const vectorRow = db
      .query<VectorRow, [string, string]>(
        "SELECT embedding FROM content_vectors WHERE mirror_hash = ? AND model = ? AND seq = 0 LIMIT 1"
      )
      .get(doc.mirrorHash, embedModel);

    const fallbackRow =
      vectorRow ??
      db
        .query<VectorRow, [string, string]>(
          "SELECT embedding FROM content_vectors WHERE mirror_hash = ? AND model = ? ORDER BY seq LIMIT 1"
        )
        .get(doc.mirrorHash, embedModel);

    if (!fallbackRow) {
      return {
        success: false,
        error: "Document has no embeddings. Run: gno embed",
        isValidation: true,
      };
    }

    // Normalize embedding for cosine similarity
    const { decodeEmbedding } =
      await import("../../store/vector/sqlite-vec.js");
    const embedding = decodeEmbedding(fallbackRow.embedding);
    const dimensions = embedding.length;
    let norm = 0;
    for (let i = 0; i < dimensions; i++) {
      const val = embedding[i] ?? 0;
      norm += val * val;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dimensions; i++) {
        embedding[i] = (embedding[i] ?? 0) / norm;
      }
    }

    // Create vector index port for search
    const { createVectorIndexPort } =
      await import("../../store/vector/sqlite-vec.js");
    const vecResult = await createVectorIndexPort(db, {
      model: embedModel,
      dimensions,
    });
    if (!vecResult.ok) {
      return { success: false, error: vecResult.error.message };
    }
    const vectorIndex = vecResult.value;

    if (!vectorIndex.searchAvailable) {
      return {
        success: false,
        error:
          "Vector search requires sqlite-vec. Embeddings exist but KNN search disabled.",
      };
    }

    // Search for more candidates to handle filtering
    // Use larger pool to account for self, inactive docs, collection filter, duplicates
    const candidateLimit = Math.min(limit * 20, 200);
    const searchResult = await vectorIndex.searchNearest(
      embedding,
      candidateLimit,
      {}
    );
    if (!searchResult.ok) {
      return { success: false, error: searchResult.error.message };
    }

    // Build mirrorHash -> doc map from a single listDocuments call
    const docsResult = crossCollection
      ? await store.listDocuments()
      : await store.listDocuments(doc.collection);

    if (!docsResult.ok) {
      return { success: false, error: docsResult.error.message };
    }

    const docsByHash = new Map<string, DocumentRow>();
    for (const d of docsResult.value) {
      if (d.active && d.mirrorHash) {
        // Only keep first doc per hash (they have same content)
        if (!docsByHash.has(d.mirrorHash)) {
          docsByHash.set(d.mirrorHash, d);
        }
      }
    }

    // Map results to documents, excluding self
    const similarItems: SimilarItem[] = [];
    const seenDocids = new Set<string>();

    for (const vec of searchResult.value) {
      if (similarItems.length >= limit) {
        break;
      }

      const d = docsByHash.get(vec.mirrorHash);
      if (!d) continue;

      // Exclude self
      if (d.docid === doc.docid) continue;

      // Skip if already seen
      if (seenDocids.has(d.docid)) continue;

      // Compute similarity score from cosine distance
      // sqlite-vec with cosine metric returns distance where similarity = 1 - distance
      const score = Math.max(0, Math.min(1, 1 - vec.distance));

      if (score < threshold) continue;

      similarItems.push({
        docid: d.docid,
        uri: d.uri,
        ...(d.title && { title: d.title }),
        score,
        collection: d.collection,
        relPath: d.relPath,
      });

      seenDocids.add(d.docid);
    }

    // Sort by score descending
    similarItems.sort((a, b) => b.score - a.score);

    return {
      success: true,
      data: {
        similar: similarItems.slice(0, limit),
        meta: {
          docid: doc.docid,
          uri: doc.uri,
          ...(doc.title && { title: doc.title }),
          totalResults: similarItems.length,
          limit,
          threshold,
          crossCollection,
        },
      },
    };
  } finally {
    await store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

/** Escape markdown table cell content */
function escapeTableCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Format links list result for output.
 */
export function formatLinksList(
  result: LinksListResult,
  options: LinksListOptions
): string {
  if (!result.success) {
    if (options.json) {
      return JSON.stringify({
        error: { code: "LINKS_LIST_FAILED", message: result.error },
      });
    }
    return `Error: ${result.error}`;
  }

  const { data } = result;

  if (options.json) {
    return JSON.stringify(data, null, 2);
  }

  if (options.md) {
    if (data.links.length === 0) {
      return `# Links from ${data.meta.docid}\n\nNo outgoing links found.`;
    }
    const lines: string[] = [
      `# Links from ${escapeTableCell(data.meta.title ?? data.meta.docid)}`,
      "",
      `*${data.meta.totalLinks} links (${data.meta.resolvedCount} resolved)*`,
      "",
      "| TargetRef | Text | Type | Line | Resolved |",
      "|-----------|------|------|------|----------|",
    ];
    for (const l of data.links) {
      const targetRef = escapeTableCell(l.targetRef);
      const text = l.linkText ? escapeTableCell(l.linkText) : "-";
      const resolved = l.resolved ? `\`${l.resolvedDocid}\`` : "-";
      lines.push(
        `| ${targetRef} | ${text} | ${l.linkType} | ${l.startLine} | ${resolved} |`
      );
    }
    return lines.join("\n");
  }

  // Terminal format
  if (data.links.length === 0) {
    return "No outgoing links found.";
  }

  const lines: string[] = [];
  for (const l of data.links) {
    const target = l.targetRef;
    const status = l.resolved ? `-> ${l.resolvedDocid}` : "(unresolved)";
    lines.push(
      `${l.startLine}:${l.startCol}\t${l.linkType}\t${target}\t${status}`
    );
  }
  lines.push("");
  lines.push(
    `${data.meta.totalLinks} links (${data.meta.resolvedCount} resolved)`
  );
  return lines.join("\n");
}

/**
 * Format backlinks result for output.
 */
export function formatBacklinks(
  result: BacklinksResult,
  options: BacklinksOptions
): string {
  if (!result.success) {
    if (options.json) {
      return JSON.stringify({
        error: { code: "BACKLINKS_FAILED", message: result.error },
      });
    }
    return `Error: ${result.error}`;
  }

  const { data } = result;

  if (options.json) {
    return JSON.stringify(data, null, 2);
  }

  if (options.md) {
    if (data.backlinks.length === 0) {
      return `# Backlinks to ${data.meta.docid}\n\nNo backlinks found.`;
    }
    const lines: string[] = [
      `# Backlinks to ${escapeTableCell(data.meta.title ?? data.meta.docid)}`,
      "",
      `*${data.meta.totalBacklinks} documents link here*`,
      "",
      "| Source | Line | Link Text |",
      "|--------|------|-----------|",
    ];
    for (const bl of data.backlinks) {
      const source = escapeTableCell(bl.sourceTitle ?? bl.sourceDocid);
      const text = bl.linkText ? escapeTableCell(bl.linkText) : "-";
      lines.push(`| ${source} | ${bl.startLine} | ${text} |`);
    }
    return lines.join("\n");
  }

  // Terminal format
  if (data.backlinks.length === 0) {
    return "No backlinks found.";
  }

  const lines: string[] = [];
  for (const bl of data.backlinks) {
    const source = bl.sourceTitle ?? bl.sourceDocid;
    const text = bl.linkText ? `"${bl.linkText}"` : "";
    lines.push(`${source}\t${bl.startLine}:${bl.startCol}\t${text}`);
  }
  lines.push("");
  lines.push(`${data.meta.totalBacklinks} backlinks`);
  return lines.join("\n");
}

/**
 * Format similar result for output.
 */
export function formatSimilar(
  result: SimilarResult,
  options: SimilarOptions
): string {
  if (!result.success) {
    if (options.json) {
      return JSON.stringify({
        error: { code: "SIMILAR_FAILED", message: result.error },
      });
    }
    return `Error: ${result.error}`;
  }

  const { data } = result;

  if (options.json) {
    return JSON.stringify(data, null, 2);
  }

  if (options.md) {
    if (data.similar.length === 0) {
      return `# Similar to ${data.meta.docid}\n\nNo similar documents found.`;
    }
    const lines: string[] = [
      `# Similar to ${escapeTableCell(data.meta.title ?? data.meta.docid)}`,
      "",
      `*${data.meta.totalResults} similar documents*`,
      "",
      "| Score | Document | Collection |",
      "|-------|----------|------------|",
    ];
    for (const s of data.similar) {
      const scoreStr = (s.score * 100).toFixed(1) + "%";
      const title = escapeTableCell(s.title ?? s.docid);
      lines.push(`| ${scoreStr} | ${title} | ${s.collection} |`);
    }
    return lines.join("\n");
  }

  // Terminal format
  if (data.similar.length === 0) {
    return "No similar documents found.";
  }

  const lines: string[] = [];
  for (const s of data.similar) {
    const scoreStr = (s.score * 100).toFixed(1) + "%";
    const title = s.title ?? s.docid;
    lines.push(`${scoreStr}\t${title}\t${s.collection}/${s.relPath}`);
  }
  return lines.join("\n");
}
