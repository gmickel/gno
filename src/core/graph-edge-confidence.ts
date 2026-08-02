/**
 * Shared confidence classification for resolved wiki/markdown graph edges.
 * Kept in sync with getGraph so query-time seed expansion matches CLI/API graph.
 *
 * @module src/core/graph-edge-confidence
 */

import type { GraphEdgeAudit, GraphEdgeConfidence } from "../store/types";

export const GRAPH_EDGE_CONFIDENCE_RANK: Record<GraphEdgeConfidence, number> = {
  explicit: 1,
  inferred: 2,
  ambiguous: 3,
  similarity: 4,
};

export function classifyResolvedGraphEdge(
  linkType: "wiki" | "markdown",
  matchRank: number | null,
  matchCount: number | null
): { confidence: GraphEdgeConfidence; audit: GraphEdgeAudit } {
  if (linkType === "markdown") {
    return {
      confidence: "explicit",
      audit: { resolution: "exact-path", matchCount: 1 },
    };
  }

  const count = matchCount ?? 0;
  if (count > 1) {
    return {
      confidence: "ambiguous",
      audit: {
        resolution: "ambiguous-fallback",
        matchCount: count,
      },
    };
  }

  if (matchRank === 1 || matchRank === 2) {
    return {
      confidence: "explicit",
      audit: { resolution: "exact-title", matchCount: count || 1 },
    };
  }
  if (matchRank === 5 || matchRank === 6) {
    return {
      confidence: "explicit",
      audit: { resolution: "exact-path", matchCount: count || 1 },
    };
  }

  return {
    confidence: "inferred",
    audit: { resolution: "path-fallback", matchCount: count || 1 },
  };
}

export function mergeGraphEdgeAudit(
  current: {
    confidence: GraphEdgeConfidence;
    audit: GraphEdgeAudit;
  },
  nextConfidence: GraphEdgeConfidence,
  nextAudit: GraphEdgeAudit
): void {
  if (
    GRAPH_EDGE_CONFIDENCE_RANK[nextConfidence] <
    GRAPH_EDGE_CONFIDENCE_RANK[current.confidence]
  ) {
    current.confidence = nextConfidence;
    current.audit = {
      ...nextAudit,
      matchCount: Math.max(
        current.audit.matchCount ?? 0,
        nextAudit.matchCount ?? 0
      ),
    };
    return;
  }
  if (
    nextAudit.matchCount !== undefined &&
    (current.audit.matchCount ?? 0) < nextAudit.matchCount
  ) {
    current.audit = {
      ...current.audit,
      matchCount: nextAudit.matchCount,
    };
  }
}
