import type { ChunkingParams } from "../config/chunking";

export interface ChunkingPolicyToken {
  params: ChunkingParams;
  generation: number;
}

export interface PendingChunkingMirror {
  mirrorHash: string;
  sourcePath: string;
  languageHint?: string;
}

export interface ChunkingStatus {
  configured: ChunkingParams;
  applied: ChunkingParams | null;
  state: "empty" | "legacy-default" | "current" | "pending" | "mixed";
  pendingDocuments: number;
  pendingMirrors: number;
}

export class ChunkingPolicyConflictError extends Error {
  readonly code = "CHUNKING_POLICY_CONFLICT";

  constructor() {
    super(
      "CHUNKING_POLICY_CONFLICT: The index chunking policy changed. Reopen the client or restart the resident runtime with the intended configuration."
    );
    this.name = "ChunkingPolicyConflictError";
  }
}
