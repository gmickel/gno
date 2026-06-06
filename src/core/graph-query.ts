/**
 * Shared bounded typed-edge graph traversal.
 *
 * @module src/core/graph-query
 */

import type { NormalizedContentTypeRule } from "../config";
import type {
  DocumentRow,
  GraphQueryNode,
  GraphQueryOptions,
  GraphQueryResult,
  StorePort,
} from "../store/types";

import { resolveDocRef } from "./ref-parser";

export type DiagnoseGraphQueryResult =
  | { success: true; data: GraphQueryResult }
  | { success: false; error: string; isValidation?: boolean };

export interface DiagnoseGraphQueryOptions extends GraphQueryOptions {
  contentTypeRules?: NormalizedContentTypeRule[];
}

function graphHintsForDoc(
  doc: DocumentRow,
  rules: NormalizedContentTypeRule[]
): string[] {
  if (!doc.contentType) {
    return [];
  }
  return rules.find((rule) => rule.id === doc.contentType)?.graphHints ?? [];
}

function toNode(
  doc: DocumentRow,
  depth: number,
  rules: NormalizedContentTypeRule[]
): GraphQueryNode {
  return {
    id: doc.docid,
    uri: doc.uri,
    title: doc.title,
    collection: doc.collection,
    relPath: doc.relPath,
    depth,
    graphHints: graphHintsForDoc(doc, rules),
  };
}

export async function diagnoseGraphQuery(
  store: StorePort,
  rootRef: string,
  options: DiagnoseGraphQueryOptions = {}
): Promise<DiagnoseGraphQueryResult> {
  const resolved = await resolveDocRef(store, rootRef);
  if ("error" in resolved) {
    return {
      success: false,
      error: resolved.error,
      isValidation: resolved.isValidation,
    };
  }

  const rootDoc = resolved.doc;
  if (!rootDoc.active) {
    return {
      success: false,
      error: `Document is inactive: ${rootRef}`,
      isValidation: true,
    };
  }

  const direction = options.direction ?? "both";
  const traversal = await store.queryGraphTraversal(rootDoc.id, {
    direction,
    edgeType: options.edgeType,
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
    frontierLimit: options.frontierLimit,
    visitedLimit: options.visitedLimit,
  });
  if (!traversal.ok) {
    return { success: false, error: traversal.error.message };
  }

  const rules = options.contentTypeRules ?? [];
  const nodes = traversal.value.nodes
    .map(({ doc, depth }) => toNode(doc, depth, rules))
    .sort((a, b) => a.depth - b.depth || a.uri.localeCompare(b.uri));
  const root =
    nodes.find((node) => node.id === rootDoc.docid) ??
    toNode(rootDoc, 0, rules);
  const edges = traversal.value.edges
    .map(({ edge, depth }) => ({
      source: edge.sourceDocid,
      target: edge.targetDocid,
      edgeType: edge.edgeType,
      relationType: edge.relationType,
      confidence: edge.confidence,
      edgeSource: edge.edgeSource,
      depth,
    }))
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        a.edgeType.localeCompare(b.edgeType) ||
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target)
    );

  return {
    success: true,
    data: {
      schemaVersion: "1.0",
      root,
      nodes,
      edges,
      meta: {
        direction,
        edgeType: options.edgeType ?? null,
        maxDepth: Math.max(1, Math.min(options.maxDepth ?? 2, 6)),
        maxNodes: Math.max(1, Math.min(options.maxNodes ?? 100, 1_000)),
        frontierLimit: Math.max(
          1,
          Math.min(options.frontierLimit ?? 100, 1_000)
        ),
        visitedLimit: Math.max(1, Math.min(options.visitedLimit ?? 500, 5_000)),
        returnedNodes: nodes.length,
        returnedEdges: edges.length,
        truncated: traversal.value.truncated,
        warnings: traversal.value.warnings,
      },
    },
  };
}
