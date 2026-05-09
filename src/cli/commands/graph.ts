/**
 * gno graph command implementation.
 * Outputs knowledge graph of document links.
 *
 * @module src/cli/commands/graph
 */

import type { GetGraphOptions, GraphResult } from "../../store/types";

import { initStore } from "./shared";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphOptions {
  /** Override config path */
  configPath?: string;
  /** Filter by collection */
  collection?: string;
  /** Max nodes (default 2000) */
  limitNodes?: number;
  /** Max edges (default 10000) */
  limitEdges?: number;
  /** Include similarity edges */
  includeSimilar?: boolean;
  /** Similarity threshold (0-1) */
  threshold?: number;
  /** Include isolated nodes */
  includeIsolated?: boolean;
  /** Similar top-K per node */
  similarTopK?: number;
  /** Output format: json (default), dot, mermaid */
  format?: "json" | "dot" | "mermaid";
  /** Show neighbors for a graph node/ref */
  neighbors?: string;
  /** Neighbor direction */
  direction?: "both" | "out" | "in";
  /** Path start graph node/ref */
  from?: string;
  /** Path target graph node/ref */
  to?: string;
  /** Max path hops */
  maxDepth?: number;
}

export type GraphCommandResult =
  | { success: true; data: GraphResult }
  | { success: true; data: GraphNeighborsCliResult }
  | { success: true; data: GraphPathCliResult }
  | { success: false; error: string; isValidation?: boolean };

type GraphNode = GraphResult["nodes"][number];
type GraphLink = GraphResult["links"][number];

interface GraphNeighborCliItem {
  node: GraphNode;
  direction: "out" | "in";
  edge: GraphLink;
}

interface GraphNeighborsCliResult {
  source: GraphNode;
  neighbors: GraphNeighborCliItem[];
  meta: GraphResult["meta"] & {
    mode: "neighbors";
    direction: "both" | "out" | "in";
    totalNeighbors: number;
  };
}

interface GraphPathCliResult {
  from: GraphNode;
  to: GraphNode;
  path: { nodes: GraphNode[]; edges: GraphLink[] } | null;
  meta: GraphResult["meta"] & {
    mode: "path";
    maxDepth: number;
    found: boolean;
    hops: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Command: graph
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno graph command.
 * Returns knowledge graph of document links.
 */
export async function graph(
  options: GraphOptions = {}
): Promise<GraphCommandResult> {
  const initResult = await initStore({
    configPath: options.configPath,
    syncConfig: false,
  });
  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }
  const { store } = initResult;

  try {
    const storeOptions: GetGraphOptions = {
      collection: options.collection,
      limitNodes: options.limitNodes,
      limitEdges: options.limitEdges,
      includeSimilar: options.includeSimilar,
      threshold: options.threshold,
      linkedOnly: !options.includeIsolated,
      similarTopK: options.similarTopK,
    };

    const result = await store.getGraph(storeOptions);
    if (!result.ok) {
      return { success: false, error: result.error.message };
    }

    if (options.neighbors) {
      const source = resolveGraphNode(result.value, options.neighbors);
      if (!source) {
        return {
          success: false,
          error: `Graph node not found: ${options.neighbors}`,
          isValidation: true,
        };
      }
      const direction = options.direction ?? "both";
      const neighbors = getGraphNeighbors(result.value, source, direction);
      return {
        success: true,
        data: {
          source,
          neighbors,
          meta: {
            ...result.value.meta,
            mode: "neighbors",
            direction,
            totalNeighbors: neighbors.length,
          },
        },
      };
    }

    if (options.from || options.to) {
      if (!(options.from && options.to)) {
        return {
          success: false,
          error: "--from and --to must be used together",
          isValidation: true,
        };
      }
      const from = resolveGraphNode(result.value, options.from);
      const to = resolveGraphNode(result.value, options.to);
      if (!from || !to) {
        return {
          success: false,
          error: `Graph node not found: ${from ? options.to : options.from}`,
          isValidation: true,
        };
      }
      const maxDepth = options.maxDepth ?? 6;
      const path = findShortestPath(result.value, from, to, maxDepth);
      return {
        success: true,
        data: {
          from,
          to,
          path,
          meta: {
            ...result.value.meta,
            mode: "path",
            maxDepth,
            found: path !== null,
            hops: path ? path.edges.length : 0,
          },
        },
      };
    }

    return { success: true, data: result.value };
  } finally {
    await store.close();
  }
}

function resolveGraphNode(
  graphResult: GraphResult,
  ref: string
): GraphNode | null {
  const normalized = ref.trim().toLowerCase();
  return (
    graphResult.nodes.find((node) => {
      const title = node.title?.toLowerCase();
      return (
        node.id.toLowerCase() === normalized ||
        node.uri.toLowerCase() === normalized ||
        node.relPath.toLowerCase() === normalized ||
        `${node.collection}/${node.relPath}`.toLowerCase() === normalized ||
        title === normalized
      );
    }) ?? null
  );
}

function getGraphNeighbors(
  graphResult: GraphResult,
  source: GraphNode,
  direction: "both" | "out" | "in"
): GraphNeighborCliItem[] {
  const nodesById = new Map(graphResult.nodes.map((node) => [node.id, node]));
  const neighbors: GraphNeighborCliItem[] = [];
  for (const edge of graphResult.links) {
    if (direction !== "in" && edge.source === source.id) {
      const node = nodesById.get(edge.target);
      if (node) neighbors.push({ node, direction: "out", edge });
    }
    if (direction !== "out" && edge.target === source.id) {
      const node = nodesById.get(edge.source);
      if (node) neighbors.push({ node, direction: "in", edge });
    }
  }
  return neighbors.sort((a, b) => a.node.uri.localeCompare(b.node.uri));
}

function findShortestPath(
  graphResult: GraphResult,
  from: GraphNode,
  to: GraphNode,
  maxDepth: number
): { nodes: GraphNode[]; edges: GraphLink[] } | null {
  const nodesById = new Map(graphResult.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, Array<{ next: string; edge: GraphLink }>>();
  for (const edge of graphResult.links) {
    const sourceEdges = adjacency.get(edge.source) ?? [];
    sourceEdges.push({ next: edge.target, edge });
    adjacency.set(edge.source, sourceEdges);

    const targetEdges = adjacency.get(edge.target) ?? [];
    targetEdges.push({ next: edge.source, edge });
    adjacency.set(edge.target, targetEdges);
  }

  const queue: Array<{ id: string; edges: GraphLink[] }> = [
    { id: from.id, edges: [] },
  ];
  const visited = new Set([from.id]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.id === to.id) {
      const nodeIds = [from.id];
      let cursor = from.id;
      for (const edge of current.edges) {
        cursor = edge.source === cursor ? edge.target : edge.source;
        nodeIds.push(cursor);
      }
      return {
        nodes: nodeIds
          .map((id) => nodesById.get(id))
          .filter((node): node is GraphNode => node !== undefined),
        edges: current.edges,
      };
    }
    if (current.edges.length >= maxDepth) continue;
    for (const { next, edge } of adjacency.get(current.id) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push({ id: next, edges: [...current.edges, edge] });
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

/** Escape string for DOT format (double quotes, newlines) */
function escapeDot(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Escape string for Mermaid (quotes, brackets, newlines) */
function escapeMermaid(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "#quot;")
    .replace(/\[/g, "#lbrack;")
    .replace(/\]/g, "#rbrack;")
    .replace(/\n/g, " ");
}

/**
 * Format graph result as DOT (Graphviz).
 */
export function formatDot(result: GraphResult): string {
  const lines: string[] = ["digraph G {"];
  lines.push("  rankdir=LR;");
  lines.push(
    '  node [shape=box, style="rounded,filled", fillcolor="#f0f0f0"];'
  );

  // Nodes
  for (const node of result.nodes) {
    const label = escapeDot(node.title ?? node.id);
    lines.push(`  "${escapeDot(node.id)}" [label="${label}"];`);
  }

  // Edges
  for (const link of result.links) {
    const style =
      link.type === "similar"
        ? 'style=dashed, color="#888888", dir=none'
        : link.confidence === "ambiguous"
          ? 'style=dotted, color="#d97706"'
          : link.confidence === "inferred"
            ? 'style=dashed, color="#64748b"'
            : "";
    const attrs = [
      style,
      `label="${escapeDot(`${link.type}/${link.confidence}`)}"`,
    ].filter(Boolean);
    lines.push(
      `  "${escapeDot(link.source)}" -> "${escapeDot(link.target)}" [${attrs.join(", ")}];`
    );
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Format graph result as Mermaid.
 */
export function formatMermaid(result: GraphResult): string {
  const lines: string[] = ["graph LR"];

  // Build node ID map (Mermaid needs simple IDs)
  const nodeIds = new Map<string, string>();
  result.nodes.forEach((node, i) => {
    nodeIds.set(node.id, `n${i}`);
  });

  // Nodes with labels
  for (const node of result.nodes) {
    const mermaidId = nodeIds.get(node.id) ?? node.id;
    const label = escapeMermaid(node.title ?? node.id);
    lines.push(`  ${mermaidId}["${label}"]`);
  }

  // Edges
  for (const link of result.links) {
    const sourceId = nodeIds.get(link.source) ?? link.source;
    const targetId = nodeIds.get(link.target) ?? link.target;
    const arrow = link.type === "similar" ? "---" : "-->";
    lines.push(
      `  ${sourceId} ${arrow}|${escapeMermaid(`${link.type}/${link.confidence}`)}| ${targetId}`
    );
  }

  return lines.join("\n");
}

/**
 * Format graph result for output.
 */
export function formatGraph(
  result: GraphCommandResult,
  options: GraphOptions
): string {
  if (!result.success) {
    if (options.format === "json" || !options.format) {
      return JSON.stringify({
        error: { code: "GRAPH_FAILED", message: result.error },
      });
    }
    return `Error: ${result.error}`;
  }

  const { data } = result;

  if ("neighbors" in data) {
    if (options.format === "json" || !options.format) {
      return JSON.stringify(data, null, 2);
    }
    if (data.neighbors.length === 0) {
      return `No graph neighbors found for ${data.source.uri} (direction=${data.meta.direction})`;
    }
    const lines = [
      `Found ${data.neighbors.length} graph neighbors for ${data.source.uri}:`,
      "",
    ];
    for (const item of data.neighbors) {
      const title = item.node.title ? ` "${item.node.title}"` : "";
      lines.push(
        `  [${item.direction}] ${item.node.uri}${title} (${item.edge.type}, ${item.edge.confidence}, weight: ${item.edge.weight})`
      );
    }
    return lines.join("\n");
  }

  if ("path" in data) {
    if (options.format === "json" || !options.format) {
      return JSON.stringify(data, null, 2);
    }
    if (!data.path) {
      return `No graph path found from ${data.from.uri} to ${data.to.uri} within ${data.meta.maxDepth} hops`;
    }
    return `Graph path (${data.meta.hops} hops):\n${data.path.nodes.map((node) => node.uri).join(" -> ")}`;
  }

  switch (options.format) {
    case "dot":
      return formatDot(data);
    case "mermaid":
      return formatMermaid(data);
    case "json":
    default:
      return JSON.stringify(data, null, 2);
  }
}
