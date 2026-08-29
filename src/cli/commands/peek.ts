/**
 * gno peek command — cheap metadata snapshot for desktop integrations.
 *
 * @module src/cli/commands/peek
 */

import type { BuildPeekOptions, PeekSnapshot } from "../../core/peek";

import { buildPeekSnapshot } from "../../core/peek";

export type PeekOptions = BuildPeekOptions & {
  json?: boolean;
};

export async function peek(options: PeekOptions = {}): Promise<PeekSnapshot> {
  return buildPeekSnapshot({
    configPath: options.configPath,
    indexName: options.indexName,
  });
}

function formatTerminal(snapshot: PeekSnapshot): string {
  const lines = [
    `schema: ${snapshot.schemaVersion}`,
    `gno: ${snapshot.gnoVersion}`,
    `index: ${snapshot.indexName}`,
    `initialized: ${snapshot.initialized ? "yes" : "no"}`,
  ];
  if (snapshot.counts) {
    lines.push(
      `documents: ${snapshot.counts.documents}`,
      `collections: ${snapshot.counts.collections}`
    );
  }
  if (snapshot.backlog) {
    lines.push(
      `backlog: ${snapshot.backlog.pending} pending, ${snapshot.backlog.failed} failed`
    );
  }
  if (snapshot.lastIndexedAt) {
    lines.push(`lastIndexedAt: ${snapshot.lastIndexedAt}`);
  }
  lines.push(
    snapshot.serve.running && snapshot.serve.url
      ? `serve: ${snapshot.serve.url}`
      : "serve: down"
  );
  if (snapshot.recent.length > 0) {
    lines.push("recent:");
    for (const item of snapshot.recent) {
      const label = item.title ?? item.uri;
      lines.push(`  ${item.docid} ${label}`);
    }
  }
  return lines.join("\n");
}

export function formatPeek(
  snapshot: PeekSnapshot,
  options: Pick<PeekOptions, "json"> = {}
): string {
  if (options.json) {
    return JSON.stringify(snapshot, null, 2);
  }
  return formatTerminal(snapshot);
}
