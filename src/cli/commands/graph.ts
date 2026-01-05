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
}

export type GraphCommandResult =
  | { success: true; data: GraphResult }
  | { success: false; error: string; isValidation?: boolean };

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
  const initResult = await initStore({ configPath: options.configPath });
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

    return { success: true, data: result.value };
  } finally {
    await store.close();
  }
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
        ? ' [style=dashed, color="#888888", dir=none]'
        : "";
    lines.push(
      `  "${escapeDot(link.source)}" -> "${escapeDot(link.target)}"${style};`
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
    lines.push(`  ${sourceId} ${arrow} ${targetId}`);
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
