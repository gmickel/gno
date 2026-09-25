import type {
  VectorPartitionStatus,
  VectorRuntimeStatus,
} from "../store/vector/status";

const shortId = (id: string): string => id.slice(0, 12);

function runtimeLine(runtime: VectorRuntimeStatus): string {
  const label = runtime.label ? ` (${runtime.label})` : "";
  if (runtime.state === "vectors")
    return `  This runtime${label} reads ${shortId(runtime.partition ?? "")}`;
  if (runtime.state === "unavailable")
    return `  This runtime${label} uses lexical retrieval only: ${runtime.reason}`;
  return "  This runtime has not resolved a partition yet; run a query or `gno embed`";
}

/**
 * The caller's runtime, then one line per partition. The healthy case (one
 * current partition this runtime reads) prints nothing, so default status
 * output is unchanged.
 */
export function formatVectorPartitionLines(
  partitions?: VectorPartitionStatus[],
  runtime?: VectorRuntimeStatus
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
  if (runtime) lines.push(runtimeLine(runtime));
  for (const p of partitions) {
    const role = p.retrieval
      ? " (used by this runtime's retrieval)"
      : p.droppable
        ? ` (drop with: gno vec drop ${shortId(p.id)})`
        : "";
    lines.push(
      `  ${p.retrieval ? "*" : " "} ${shortId(p.id)} ${p.state}${p.legacy ? " legacy" : ""}, ${p.owners} chunks, ${p.provenance}${role}`
    );
    if (p.compatibleRuntimes.length)
      lines.push(`      read by: ${p.compatibleRuntimes.join("; ")}`);
    if (p.incompatibleRuntimes.length)
      lines.push(`      incompatible: ${p.incompatibleRuntimes.join("; ")}`);
  }
  return lines;
}
