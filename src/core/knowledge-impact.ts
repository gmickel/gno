/**
 * Bounded, cycle-safe inbound dependency impact analysis.
 */

import type { DocEdgeRow, DocumentRow, StorePort } from "../store/types";
import type {
  KnowledgeDeltaServiceResult,
  KnowledgeDocument,
} from "./knowledge-delta";

import { resolveDocRef } from "./ref-parser";

export interface KnowledgeImpactEvidenceStep {
  source: Pick<KnowledgeDocument, "id" | "uri">;
  target: Pick<KnowledgeDocument, "id" | "uri">;
  edgeType: string;
  relationType: string;
  confidence: DocEdgeRow["confidence"];
  edgeSource: DocEdgeRow["edgeSource"];
}

export interface KnowledgeImpactResult {
  schemaVersion: "1.0";
  root: KnowledgeDocument;
  impacted: Array<{
    document: KnowledgeDocument;
    depth: number;
    evidencePath: KnowledgeImpactEvidenceStep[];
  }>;
  meta: {
    maxDepth: number;
    maxNodes: number;
    maxEdges: number;
    frontierLimit: number;
    visitedLimit: number;
    returnedNodes: number;
    returnedEdges: number;
    truncated: boolean;
    warnings: string[];
  };
}

export interface KnowledgeImpactInput {
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
  frontierLimit?: number;
  visitedLimit?: number;
}

const document = (row: DocumentRow): KnowledgeDocument => ({
  id: row.docid,
  uri: row.uri,
  title: row.title,
  collection: row.collection,
  relPath: row.relPath,
});

const bounded = (
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number
): number | { error: string } => {
  const resolved = value ?? fallback;
  return Number.isSafeInteger(resolved) && resolved >= 1 && resolved <= maximum
    ? resolved
    : { error: `${name} must be between 1 and ${maximum}` };
};

const edgeStep = (edge: DocEdgeRow): KnowledgeImpactEvidenceStep => ({
  source: { id: edge.sourceDocid, uri: edge.sourceUri },
  target: { id: edge.targetDocid, uri: edge.targetUri },
  edgeType: edge.edgeType,
  relationType: edge.relationType,
  confidence: edge.confidence,
  edgeSource: edge.edgeSource,
});

export async function analyzeKnowledgeImpact(
  store: StorePort,
  ref: string,
  input: KnowledgeImpactInput = {}
): Promise<KnowledgeDeltaServiceResult<KnowledgeImpactResult>> {
  if (!ref.trim() || ref.length > 4096) {
    return {
      success: false,
      error: "ref must be between 1 and 4096 characters",
      isValidation: true,
    };
  }
  const caps = {
    maxDepth: bounded("maxDepth", input.maxDepth, 3, 6),
    maxNodes: bounded("maxNodes", input.maxNodes, 100, 1000),
    maxEdges: bounded("maxEdges", input.maxEdges, 250, 5000),
    frontierLimit: bounded("frontierLimit", input.frontierLimit, 100, 1000),
    visitedLimit: bounded("visitedLimit", input.visitedLimit, 500, 5000),
  };
  const invalid = Object.values(caps).find(
    (value): value is { error: string } => typeof value === "object"
  );
  if (invalid) {
    return { success: false, error: invalid.error, isValidation: true };
  }
  const values = caps as Record<keyof typeof caps, number>;
  const resolved = await resolveDocRef(store, ref);
  if ("error" in resolved) {
    return {
      success: false,
      error: resolved.error,
      isValidation: resolved.isValidation,
    };
  }
  if (!resolved.doc.active) {
    return {
      success: false,
      error: `Document is inactive: ${ref}`,
      isValidation: true,
    };
  }
  const traversal = await store.queryGraphTraversal(resolved.doc.id, {
    direction: "in",
    maxDepth: values.maxDepth,
    maxNodes: values.maxNodes,
    frontierLimit: values.frontierLimit,
    visitedLimit: values.visitedLimit,
  });
  if (!traversal.ok) {
    return { success: false, error: traversal.error.message };
  }
  const sortedEdges = [...traversal.value.edges]
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        a.edge.edgeType.localeCompare(b.edge.edgeType) ||
        a.edge.sourceUri.localeCompare(b.edge.sourceUri) ||
        a.edge.targetUri.localeCompare(b.edge.targetUri)
    )
    .slice(0, values.maxEdges);
  const incoming = new Map<string, DocEdgeRow[]>();
  for (const { edge } of sortedEdges) {
    const entries = incoming.get(edge.targetDocid) ?? [];
    entries.push(edge);
    incoming.set(edge.targetDocid, entries);
  }
  const paths = new Map<string, KnowledgeImpactEvidenceStep[]>([
    [resolved.doc.docid, []],
  ]);
  const queue = [resolved.doc.docid];
  for (let index = 0; index < queue.length; index += 1) {
    const targetId = queue[index]!;
    const targetPath = paths.get(targetId) ?? [];
    for (const edge of incoming.get(targetId) ?? []) {
      if (paths.has(edge.sourceDocid)) continue;
      paths.set(edge.sourceDocid, [edgeStep(edge), ...targetPath]);
      queue.push(edge.sourceDocid);
    }
  }
  const nodesById = new Map(
    traversal.value.nodes.map(({ doc: row }) => [row.docid, document(row)])
  );
  const impacted = [...paths.entries()]
    .filter(([id]) => id !== resolved.doc.docid)
    .map(([id, evidencePath]) => ({
      document: nodesById.get(id)!,
      depth: evidencePath.length,
      evidencePath,
    }))
    .filter((item) => item.document)
    .sort(
      (a, b) =>
        a.depth - b.depth || a.document.uri.localeCompare(b.document.uri)
    );
  const warnings = [...traversal.value.warnings];
  if (traversal.value.edges.length > values.maxEdges) {
    warnings.push("maxEdges reached");
  }
  const usedEdges = new Set(
    impacted.flatMap(({ evidencePath }) =>
      evidencePath.map(
        (step) =>
          `${step.source.id}\u0000${step.target.id}\u0000${step.edgeType}`
      )
    )
  );
  return {
    success: true,
    data: {
      schemaVersion: "1.0",
      root: document(resolved.doc),
      impacted,
      meta: {
        ...values,
        returnedNodes: impacted.length + 1,
        returnedEdges: usedEdges.size,
        truncated:
          traversal.value.truncated || warnings.includes("maxEdges reached"),
        warnings: [...new Set(warnings)],
      },
    },
  };
}
