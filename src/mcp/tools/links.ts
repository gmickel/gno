/**
 * MCP link tools - gno_links, gno_backlinks, gno_similar, gno_graph.
 *
 * @module src/mcp/tools/links
 */

import { join as pathJoin } from "node:path";

import type {
  BacklinkRow,
  DocLinkRow,
  DocumentRow,
  GraphResult,
} from "../../store/types";
import type { ToolContext } from "../server";

import { parseRef } from "../../cli/commands/ref-parser";
import { MCP_ERRORS } from "../../core/errors";
import { normalizeCollectionName } from "../../core/validation";
import { getActivePreset } from "../../llm/registry";
import { createVectorIndexPort } from "../../store/vector";
import { runTool, type ToolResult } from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// Shared Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lookup document by parsed reference.
 * Returns discriminated result to distinguish parse errors from not-found.
 */
async function lookupDocument(
  ctx: ToolContext,
  ref: string
): Promise<
  { ok: true; doc: DocumentRow } | { ok: false; code: string; message: string }
> {
  const parsed = parseRef(ref);
  if ("error" in parsed) {
    return {
      ok: false,
      code: MCP_ERRORS.INVALID_INPUT.code,
      message: `Invalid ref format: ${parsed.error}`,
    };
  }

  let doc: DocumentRow | null = null;

  switch (parsed.type) {
    case "docid": {
      const result = await ctx.store.getDocumentByDocid(parsed.value);
      doc = result.ok ? result.value : null;
      break;
    }
    case "uri": {
      const result = await ctx.store.getDocumentByUri(parsed.value);
      doc = result.ok ? result.value : null;
      break;
    }
    case "collPath": {
      if (!(parsed.collection && parsed.relPath)) {
        return {
          ok: false,
          code: MCP_ERRORS.INVALID_INPUT.code,
          message: "Invalid collection/path format",
        };
      }
      // Find canonical collection name (case-insensitive)
      const canonical = ctx.collections.find(
        (c) => c.name.toLowerCase() === parsed.collection!.toLowerCase()
      );
      const collectionName = canonical?.name ?? parsed.collection;
      const result = await ctx.store.getDocument(
        collectionName,
        parsed.relPath
      );
      doc = result.ok ? result.value : null;
      break;
    }
  }

  if (!doc) {
    return {
      ok: false,
      code: MCP_ERRORS.NOT_FOUND.code,
      message: `Document not found: ${ref}`,
    };
  }

  return { ok: true, doc };
}

// ─────────────────────────────────────────────────────────────────────────────
// gno_links - Get outgoing links from a document
// ─────────────────────────────────────────────────────────────────────────────

interface LinksInput {
  ref: string;
  type?: "wiki" | "markdown";
}

interface LinkOutput {
  targetRef: string;
  targetAnchor?: string;
  targetCollection?: string;
  linkType: "wiki" | "markdown";
  linkText?: string;
  position: { startLine: number; startCol: number };
}

interface LinksResult {
  links: LinkOutput[];
  meta: {
    docid: string;
    uri: string;
    title?: string;
    totalLinks: number;
    filterType?: "wiki" | "markdown";
  };
}

function formatLinksResult(data: LinksResult): string {
  if (data.links.length === 0) {
    const filter = data.meta.filterType
      ? ` (type=${data.meta.filterType})`
      : "";
    return `No outgoing links found in ${data.meta.uri}${filter}`;
  }

  const lines: string[] = [];
  lines.push(`Found ${data.links.length} outgoing links in ${data.meta.uri}:`);
  lines.push("");

  for (const l of data.links) {
    const collection = l.targetCollection ? `${l.targetCollection}:` : "";
    const anchor = l.targetAnchor ? `#${l.targetAnchor}` : "";
    const text = l.linkText ? ` "${l.linkText}"` : "";
    lines.push(
      `  [${l.linkType}] ${collection}${l.targetRef}${anchor}${text} (line ${l.position.startLine})`
    );
  }

  return lines.join("\n");
}

export function handleLinks(
  args: LinksInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_links",
    async () => {
      // Lookup document with proper error discrimination
      const lookup = await lookupDocument(ctx, args.ref);
      if (!lookup.ok) {
        throw new Error(`${lookup.code}: ${lookup.message}`);
      }
      const { doc } = lookup;

      // Get links for document
      const linksResult = await ctx.store.getLinksForDoc(doc.id);
      if (!linksResult.ok) {
        throw new Error(linksResult.error.message);
      }

      // Filter by type if specified
      let links: DocLinkRow[] = linksResult.value;
      if (args.type) {
        links = links.filter((l) => l.linkType === args.type);
      }

      // Sort by position for deterministic output
      links.sort((a, b) => {
        if (a.startLine !== b.startLine) return a.startLine - b.startLine;
        return a.startCol - b.startCol;
      });

      // Map to output format (avoid null leakage)
      const linkOutputs: LinkOutput[] = links.map((l) => ({
        targetRef: l.targetRef,
        ...(l.targetAnchor && { targetAnchor: l.targetAnchor }),
        ...(l.targetCollection && { targetCollection: l.targetCollection }),
        linkType: l.linkType,
        ...(l.linkText && { linkText: l.linkText }),
        position: { startLine: l.startLine, startCol: l.startCol },
      }));

      return {
        links: linkOutputs,
        meta: {
          docid: doc.docid,
          uri: doc.uri,
          ...(doc.title && { title: doc.title }),
          totalLinks: linkOutputs.length,
          ...(args.type && { filterType: args.type }),
        },
      };
    },
    formatLinksResult
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// gno_backlinks - Get documents linking TO this document
// ─────────────────────────────────────────────────────────────────────────────

interface BacklinksInput {
  ref: string;
  collection?: string;
}

interface BacklinkOutput {
  sourceDocUri: string;
  sourceDocTitle?: string;
  linkText?: string;
  position: { startLine: number; startCol: number };
}

interface BacklinksResult {
  backlinks: BacklinkOutput[];
  meta: {
    docid: string;
    uri: string;
    title?: string;
    totalBacklinks: number;
    filterCollection?: string;
  };
}

function formatBacklinksResult(data: BacklinksResult): string {
  if (data.backlinks.length === 0) {
    const filter = data.meta.filterCollection
      ? ` (collection=${data.meta.filterCollection})`
      : "";
    return `No backlinks found for ${data.meta.uri}${filter}`;
  }

  const lines: string[] = [];
  lines.push(`Found ${data.backlinks.length} backlinks to ${data.meta.uri}:`);
  lines.push("");

  for (const b of data.backlinks) {
    const title = b.sourceDocTitle ? ` "${b.sourceDocTitle}"` : "";
    const text = b.linkText ? ` -> "${b.linkText}"` : "";
    lines.push(
      `  ${b.sourceDocUri}${title}${text} (line ${b.position.startLine})`
    );
  }

  return lines.join("\n");
}

export function handleBacklinks(
  args: BacklinksInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_backlinks",
    async () => {
      // Lookup document with proper error discrimination
      const lookup = await lookupDocument(ctx, args.ref);
      if (!lookup.ok) {
        throw new Error(`${lookup.code}: ${lookup.message}`);
      }
      const { doc } = lookup;

      // Validate collection if specified (case-insensitive)
      let collection: string | undefined;
      if (args.collection) {
        collection = normalizeCollectionName(args.collection);
        const exists = ctx.collections.some(
          (c) => c.name.toLowerCase() === collection?.toLowerCase()
        );
        if (!exists) {
          throw new Error(
            `${MCP_ERRORS.NOT_FOUND.code}: Collection not found: ${args.collection}`
          );
        }
      }

      // Get backlinks for document
      const backlinksResult = await ctx.store.getBacklinksForDoc(doc.id, {
        collection,
      });
      if (!backlinksResult.ok) {
        throw new Error(backlinksResult.error.message);
      }

      // Sort for deterministic output
      const sorted = [...backlinksResult.value].sort((a, b) => {
        if (a.sourceDocUri !== b.sourceDocUri) {
          return a.sourceDocUri.localeCompare(b.sourceDocUri);
        }
        if (a.startLine !== b.startLine) return a.startLine - b.startLine;
        return a.startCol - b.startCol;
      });

      // Map to output format (avoid null leakage)
      const backlinkOutputs: BacklinkOutput[] = sorted.map(
        (b: BacklinkRow) => ({
          sourceDocUri: b.sourceDocUri,
          ...(b.sourceDocTitle && { sourceDocTitle: b.sourceDocTitle }),
          ...(b.linkText && { linkText: b.linkText }),
          position: { startLine: b.startLine, startCol: b.startCol },
        })
      );

      return {
        backlinks: backlinkOutputs,
        meta: {
          docid: doc.docid,
          uri: doc.uri,
          ...(doc.title && { title: doc.title }),
          totalBacklinks: backlinkOutputs.length,
          ...(collection && { filterCollection: collection }),
        },
      };
    },
    formatBacklinksResult
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// gno_similar - Get semantically similar documents
// Uses stored embeddings only - does NOT load embedding model
// ─────────────────────────────────────────────────────────────────────────────

interface SimilarInput {
  ref: string;
  limit?: number;
  threshold?: number;
  crossCollection?: boolean;
}

interface SimilarDocOutput {
  docid: string;
  uri: string;
  title?: string;
  score: number;
  absPath?: string;
}

interface SimilarResult {
  similar: SimilarDocOutput[];
  meta: {
    docid: string;
    uri: string;
    title?: string;
    totalSimilar: number;
    limit: number;
    threshold: number;
    crossCollection: boolean;
  };
}

function formatSimilarResult(data: SimilarResult): string {
  if (data.similar.length === 0) {
    return `No similar documents found for ${data.meta.uri} (threshold=${data.meta.threshold})`;
  }

  const lines: string[] = [];
  lines.push(
    `Found ${data.similar.length} similar documents for ${data.meta.uri}:`
  );
  lines.push("");

  for (const s of data.similar) {
    const title = s.title ? ` "${s.title}"` : "";
    const pct = (s.score * 100).toFixed(1);
    lines.push(`  [${s.docid}] ${s.uri}${title} (${pct}%)`);
  }

  return lines.join("\n");
}

export function handleSimilar(
  args: SimilarInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_similar",
    async () => {
      // Lookup document with proper error discrimination
      const lookup = await lookupDocument(ctx, args.ref);
      if (!lookup.ok) {
        throw new Error(`${lookup.code}: ${lookup.message}`);
      }
      const { doc } = lookup;

      if (!doc.mirrorHash) {
        throw new Error(
          `${MCP_ERRORS.NOT_FOUND.code}: Document has no indexed content`
        );
      }

      // Get model from active preset
      const preset = getActivePreset(ctx.config);
      const modelUri = preset.embed;

      // Get stored embeddings from content_vectors (NO model loading required)
      const db = ctx.store.getRawDb();

      interface VectorRow {
        embedding: Uint8Array;
      }

      const vectorRows = db
        .query<VectorRow, [string, string]>(
          `SELECT embedding FROM content_vectors
           WHERE mirror_hash = ? AND model = ?
           ORDER BY seq`
        )
        .all(doc.mirrorHash, modelUri);

      if (vectorRows.length === 0) {
        throw new Error(
          `${MCP_ERRORS.NOT_FOUND.code}: Document has no embeddings. Run: gno embed`
        );
      }

      // Compute average embedding from all chunks
      const firstBlob = vectorRows[0]?.embedding;
      if (!firstBlob) {
        throw new Error("No embedding data available");
      }

      let dimensions: number;
      let avgEmbedding: Float32Array;

      try {
        dimensions = firstBlob.byteLength / 4;
        avgEmbedding = new Float32Array(dimensions);

        for (const row of vectorRows) {
          const blob = new Uint8Array(row.embedding);
          const embeddingDims = blob.byteLength / 4;
          if (embeddingDims !== dimensions) {
            throw new Error(
              `Inconsistent embedding dimensions: expected ${dimensions}, got ${embeddingDims}`
            );
          }
          const embedding = new Float32Array(
            blob.buffer,
            blob.byteOffset,
            embeddingDims
          );
          for (let i = 0; i < dimensions; i++) {
            const current = avgEmbedding[i] ?? 0;
            avgEmbedding[i] = current + (embedding[i] ?? 0) / vectorRows.length;
          }
        }
      } catch (e) {
        throw new Error(
          `Invalid stored embedding data: ${e instanceof Error ? e.message : String(e)}`
        );
      }

      // Normalize the average embedding for cosine similarity
      let norm = 0;
      for (let i = 0; i < dimensions; i++) {
        const val = avgEmbedding[i] ?? 0;
        norm += val * val;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < dimensions; i++) {
          avgEmbedding[i] = (avgEmbedding[i] ?? 0) / norm;
        }
      }

      // Create vector index for search
      const vectorResult = await createVectorIndexPort(db, {
        model: modelUri,
        dimensions,
      });

      if (!vectorResult.ok) {
        throw new Error(
          `Vector index not available: ${vectorResult.error.message}. Run: gno embed`
        );
      }

      const vectorIndex = vectorResult.value;

      if (!vectorIndex.searchAvailable) {
        const reason = vectorIndex.loadError
          ? `sqlite-vec not loaded: ${vectorIndex.loadError}`
          : "sqlite-vec not available";
        throw new Error(
          `Vector search unavailable (${reason}). Ensure sqlite-vec is installed.`
        );
      }

      // Parse params with defaults
      const limit = args.limit ?? 5;
      const threshold = args.threshold ?? 0.7;
      const crossCollection = args.crossCollection ?? false;

      // Search for similar documents (larger pool for filtering)
      const candidateLimit = Math.min(limit * 20, 200);
      const searchResult = await vectorIndex.searchNearest(
        avgEmbedding,
        candidateLimit,
        {}
      );

      if (!searchResult.ok) {
        throw new Error(searchResult.error.message);
      }

      // Get unique mirrorHashes, excluding self
      const mirrorHashes = [
        ...new Set(
          searchResult.value
            .filter((r) => r.mirrorHash !== doc.mirrorHash)
            .map((r) => r.mirrorHash)
        ),
      ];

      // Batch query documents by mirrorHash (avoid N+1)
      interface DocRow {
        docid: string;
        uri: string;
        title: string | null;
        collection: string;
        rel_path: string;
        mirror_hash: string;
      }

      const placeholders = mirrorHashes.map(() => "?").join(",");
      const docRows =
        mirrorHashes.length > 0
          ? (db
              .query<DocRow, string[]>(
                `SELECT docid, uri, title, collection, rel_path, mirror_hash
               FROM documents WHERE mirror_hash IN (${placeholders}) AND active = 1`
              )
              .all(...mirrorHashes) as DocRow[])
          : [];

      // Build lookup map
      const docsByHash = new Map<string, DocRow>();
      for (const row of docRows) {
        if (!docsByHash.has(row.mirror_hash)) {
          docsByHash.set(row.mirror_hash, row);
        }
      }

      // Build best score per mirrorHash from search results
      const scoresByHash = new Map<string, number>();
      for (const r of searchResult.value) {
        if (r.mirrorHash === doc.mirrorHash) continue;
        // Compute similarity score from cosine distance
        // sqlite-vec with cosine metric returns distance where similarity = 1 - distance
        const score = Math.max(0, Math.min(1, 1 - r.distance));
        const existing = scoresByHash.get(r.mirrorHash) ?? 0;
        if (score > existing) {
          scoresByHash.set(r.mirrorHash, score);
        }
      }

      // Build similar docs list
      const similar: SimilarDocOutput[] = [];
      const docCollection = doc.collection.toLowerCase();

      for (const mirrorHash of mirrorHashes) {
        if (similar.length >= limit) break;

        const docRow = docsByHash.get(mirrorHash);
        if (!docRow) continue;

        // Filter by collection if not crossCollection (case-insensitive)
        if (
          !crossCollection &&
          docRow.collection.toLowerCase() !== docCollection
        ) {
          continue;
        }

        const score = scoresByHash.get(mirrorHash) ?? 0;
        if (score < threshold) continue;

        // Get absPath (case-insensitive collection lookup)
        let absPath: string | undefined;
        const collection = ctx.collections.find(
          (c) => c.name.toLowerCase() === docRow.collection.toLowerCase()
        );
        if (collection) {
          absPath = pathJoin(collection.path, docRow.rel_path);
        }

        similar.push({
          docid: docRow.docid,
          uri: docRow.uri,
          ...(docRow.title && { title: docRow.title }),
          score,
          ...(absPath && { absPath }),
        });
      }

      // Sort by score descending
      similar.sort((a, b) => b.score - a.score);

      return {
        similar: similar.slice(0, limit),
        meta: {
          docid: doc.docid,
          uri: doc.uri,
          ...(doc.title && { title: doc.title }),
          totalSimilar: similar.length,
          limit,
          threshold,
          crossCollection,
        },
      };
    },
    formatSimilarResult
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// gno_graph - Get knowledge graph of document connections
// ─────────────────────────────────────────────────────────────────────────────

interface GraphInput {
  collection?: string;
  limit?: number;
  edgeLimit?: number;
  includeSimilar?: boolean;
  threshold?: number;
  linkedOnly?: boolean;
  similarTopK?: number;
}

function formatGraphResult(data: GraphResult): string {
  const { nodes, links, meta } = data;
  const lines: string[] = [];

  lines.push(
    `Knowledge Graph: ${meta.totalNodes} nodes, ${meta.totalEdges} edges`
  );

  if (meta.collection) {
    lines.push(`Collection: ${meta.collection}`);
  }

  if (meta.truncated) {
    lines.push(
      `(Truncated: returned ${meta.returnedNodes}/${meta.totalNodes} nodes, ${meta.returnedEdges}/${meta.totalEdges} edges)`
    );
  }

  if (meta.includedSimilar) {
    lines.push("Similarity edges: enabled");
  }

  lines.push("");
  lines.push("Top nodes by degree:");
  const topNodes = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 10);
  for (const node of topNodes) {
    const title = node.title ? ` "${node.title}"` : "";
    lines.push(`  [${node.id}] ${node.uri}${title} (degree: ${node.degree})`);
  }

  const edgeTypes = new Map<string, number>();
  for (const link of links) {
    edgeTypes.set(link.type, (edgeTypes.get(link.type) ?? 0) + 1);
  }

  lines.push("");
  lines.push("Edge breakdown:");
  for (const [type, count] of edgeTypes) {
    lines.push(`  ${type}: ${count}`);
  }

  return lines.join("\n");
}

export function handleGraph(
  args: GraphInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_graph",
    async () => {
      // Validate collection if specified (case-insensitive)
      let collection: string | undefined;
      if (args.collection) {
        collection = normalizeCollectionName(args.collection);
        const exists = ctx.collections.some(
          (c) => c.name.toLowerCase() === collection?.toLowerCase()
        );
        if (!exists) {
          throw new Error(
            `${MCP_ERRORS.NOT_FOUND.code}: Collection not found: ${args.collection}`
          );
        }
      }

      const result = await ctx.store.getGraph({
        collection,
        limitNodes: args.limit ?? 2000,
        limitEdges: args.edgeLimit ?? 10000,
        includeSimilar: args.includeSimilar ?? false,
        threshold: args.threshold ?? 0.7,
        linkedOnly: args.linkedOnly ?? true,
        similarTopK: args.similarTopK ?? 5,
      });

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      return result.value;
    },
    formatGraphResult
  );
}
