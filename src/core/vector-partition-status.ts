import type { VectorPartitionStatus } from "../store/vector/status";

const shortId = (id: string): string => id.slice(0, 12);

/**
 * One line per partition; the healthy single-partition case prints nothing so
 * default status output is unchanged.
 */
export function formatVectorPartitionLines(
  partitions?: VectorPartitionStatus[]
): string[] {
  if (!partitions?.length) return [];
  const [only] = partitions;
  if (
    partitions.length === 1 &&
    only?.retrieval &&
    !only.legacy &&
    !only.incompatibleRuntimes.length
  )
    return [];
  const lines = ["Vector partitions:"];
  for (const p of partitions) {
    const role = p.retrieval
      ? " (used by retrieval)"
      : ` (drop with: gno vec drop ${shortId(p.id)})`;
    lines.push(
      `  ${p.retrieval ? "*" : " "} ${shortId(p.id)} ${p.state}${p.legacy ? " legacy" : ""}, ${p.owners} chunks, ${p.provenance}${role}`
    );
    for (const runtime of p.incompatibleRuntimes)
      lines.push(
        `      incompatible runtime: ${runtime} (its queries use lexical retrieval only)`
      );
  }
  return lines;
}
