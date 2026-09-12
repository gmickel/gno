import type { ChunkingParams } from "../config/chunking";
import type { ChunkingStatus } from "../store/chunking";

import {
  chunkingPolicyKey,
  DEFAULT_CHUNKING_POLICY_KEY,
} from "../config/chunking";

const formatParams = (params: ChunkingParams): string =>
  `${params.maxTokens} approximate tokens / ${Number((params.overlapPercent * 100).toFixed(4))}% overlap`;

/** Keep the healthy default terminal output unchanged. */
export function formatChunkingStatus(status?: ChunkingStatus): string | null {
  if (!status) return null;
  if (
    chunkingPolicyKey(status.configured) === DEFAULT_CHUNKING_POLICY_KEY &&
    status.pendingMirrors === 0 &&
    status.state !== "mixed"
  )
    return null;
  const applied = status.applied
    ? formatParams(status.applied)
    : status.state === "empty"
      ? "none"
      : "mixed";
  const pending = status.pendingMirrors
    ? `; ${status.pendingDocuments} documents / ${status.pendingMirrors} mirrors pending (run gno update)`
    : "";
  return `Chunking: configured ${formatParams(status.configured)}; applied ${applied}${pending}`;
}
