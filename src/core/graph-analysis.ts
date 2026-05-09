import type { GraphLink, GraphNode } from "../store/types";

export interface GraphCommunity {
  id: string;
  label: string;
  size: number;
  edgeCount: number;
  density: number;
  topNodes: Array<
    Pick<
      GraphNode,
      "id" | "uri" | "title" | "collection" | "relPath" | "degree"
    >
  >;
}

export interface GraphCommunityAnalysis {
  total: number;
  algorithm: "deterministic-label-propagation";
  skipped: boolean;
  assignments: Record<string, string>;
  communities: GraphCommunity[];
  warnings: string[];
}

const DEFAULT_COMMUNITY_NODE_CAP = 2000;
const MAX_ITERATIONS = 8;

const confidenceFactor = (confidence: GraphLink["confidence"]): number => {
  switch (confidence) {
    case "explicit":
      return 1;
    case "inferred":
      return 0.75;
    case "ambiguous":
      return 0.5;
    case "similarity":
      return 0.35;
  }
};

const edgeStrength = (edge: GraphLink): number =>
  Math.max(0.01, edge.weight) * confidenceFactor(edge.confidence);

export function analyzeGraphCommunities(
  nodes: GraphNode[],
  links: GraphLink[],
  options: { nodeCap?: number } = {}
): GraphCommunityAnalysis {
  const nodeCap = options.nodeCap ?? DEFAULT_COMMUNITY_NODE_CAP;
  if (nodes.length === 0) {
    return {
      total: 0,
      algorithm: "deterministic-label-propagation",
      skipped: false,
      assignments: {},
      communities: [],
      warnings: [],
    };
  }

  if (nodes.length > nodeCap) {
    return {
      total: 0,
      algorithm: "deterministic-label-propagation",
      skipped: true,
      assignments: {},
      communities: [],
      warnings: [
        `Community detection skipped: graph has ${nodes.length} nodes (cap ${nodeCap})`,
      ],
    };
  }

  const sortedNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const nodeIds = new Set(sortedNodes.map((node) => node.id));
  const adjacency = new Map<string, Map<string, number>>();
  for (const node of sortedNodes) {
    adjacency.set(node.id, new Map());
  }

  for (const edge of links) {
    if (!(nodeIds.has(edge.source) && nodeIds.has(edge.target))) continue;
    if (edge.source === edge.target) continue;
    const strength = edgeStrength(edge);
    const sourceNeighbors = adjacency.get(edge.source);
    const targetNeighbors = adjacency.get(edge.target);
    if (!(sourceNeighbors && targetNeighbors)) continue;
    sourceNeighbors.set(
      edge.target,
      (sourceNeighbors.get(edge.target) ?? 0) + strength
    );
    targetNeighbors.set(
      edge.source,
      (targetNeighbors.get(edge.source) ?? 0) + strength
    );
  }

  const labels = new Map(sortedNodes.map((node) => [node.id, node.id]));
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let changed = false;
    for (const node of sortedNodes) {
      const neighbors = adjacency.get(node.id);
      if (!neighbors || neighbors.size === 0) continue;

      const scores = new Map<string, number>();
      for (const [neighborId, strength] of neighbors) {
        const label = labels.get(neighborId) ?? neighborId;
        scores.set(label, (scores.get(label) ?? 0) + strength);
      }

      const currentLabel = labels.get(node.id) ?? node.id;
      let bestLabel = currentLabel;
      let bestScore = scores.get(currentLabel) ?? 0;
      for (const [candidate, score] of [...scores.entries()].sort((a, b) =>
        a[0].localeCompare(b[0])
      )) {
        if (
          score > bestScore ||
          (score === bestScore && candidate < bestLabel)
        ) {
          bestLabel = candidate;
          bestScore = score;
        }
      }
      if (bestLabel !== currentLabel) {
        labels.set(node.id, bestLabel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const groups = new Map<string, GraphNode[]>();
  for (const node of sortedNodes) {
    const label = labels.get(node.id) ?? node.id;
    const group = groups.get(label) ?? [];
    group.push(node);
    groups.set(label, group);
  }

  const edgeCountByLabel = new Map<string, number>();
  for (const edge of links) {
    const sourceLabel = labels.get(edge.source);
    const targetLabel = labels.get(edge.target);
    if (!sourceLabel || sourceLabel !== targetLabel) continue;
    edgeCountByLabel.set(
      sourceLabel,
      (edgeCountByLabel.get(sourceLabel) ?? 0) + 1
    );
  }

  const orderedGroups = [...groups.entries()].sort((a, b) => {
    const sizeDelta = b[1].length - a[1].length;
    if (sizeDelta !== 0) return sizeDelta;
    const aUri = a[1][0]?.uri ?? a[0];
    const bUri = b[1][0]?.uri ?? b[0];
    return aUri.localeCompare(bUri);
  });

  const labelToCommunityId = new Map<string, string>();
  const communities = orderedGroups.map(([label, group], index) => {
    const communityId = `c${index + 1}`;
    labelToCommunityId.set(label, communityId);
    const sortedGroup = [...group].sort(
      (a, b) => b.degree - a.degree || a.uri.localeCompare(b.uri)
    );
    const edgeCount = edgeCountByLabel.get(label) ?? 0;
    const maxUndirectedEdges = (group.length * (group.length - 1)) / 2;
    return {
      id: communityId,
      label: sortedGroup[0]?.title ?? sortedGroup[0]?.relPath ?? communityId,
      size: group.length,
      edgeCount,
      density: maxUndirectedEdges > 0 ? edgeCount / maxUndirectedEdges : 0,
      topNodes: sortedGroup.slice(0, 5).map((node) => ({
        id: node.id,
        uri: node.uri,
        title: node.title,
        collection: node.collection,
        relPath: node.relPath,
        degree: node.degree,
      })),
    };
  });

  const assignments: Record<string, string> = {};
  for (const node of sortedNodes) {
    const label = labels.get(node.id) ?? node.id;
    assignments[node.id] = labelToCommunityId.get(label) ?? "c0";
  }

  return {
    total: communities.length,
    algorithm: "deterministic-label-propagation",
    skipped: false,
    assignments,
    communities: communities.slice(0, 10),
    warnings: [],
  };
}
