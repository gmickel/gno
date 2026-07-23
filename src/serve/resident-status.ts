/** Safe, transport-neutral resident lifecycle status projection. */

import type { ResidentStatus, RuntimeMode } from "./status-model";

const EMPTY_MODELS: ResidentStatus["models"] = {
  activeLeases: 0,
  leaseAcquisitions: 0,
  leaseReleases: 0,
  loadedModels: 0,
  loadAttempts: 0,
  loadSuccesses: 0,
  loadFailures: 0,
  inflightLoads: 0,
};

export function createStandaloneResidentStatus(
  mode: Extract<RuntimeMode, "stdio" | "direct-cli">
): ResidentStatus {
  return {
    schemaVersion: "1.0",
    mode,
    resident: false,
    uptimeSeconds: null,
    listenerPort: null,
    admission: { state: "closed", activeRequests: 0 },
    shutdown: { state: "none" },
    transport: {
      activeRequests: 0,
      activeSessions: 0,
      queuedRequests: 0,
      maxConcurrentRequests: 0,
      maxQueuedRequests: 0,
      maxSessions: 0,
    },
    readers: { active: 0, queued: 0, limit: 0, maxQueued: 0 },
    models: { ...EMPTY_MODELS },
    jobs: { active: 0, recent: 0, failed: 0 },
    generations: { content: 0, index: 0 },
  };
}

export interface ResidentStatusSnapshotInput {
  mode: Extract<RuntimeMode, "serve" | "daemon">;
  startedAt: number;
  listenerPort: number | null;
  admission: ResidentStatus["admission"];
  shutdown: ResidentStatus["shutdown"];
  transport: ResidentStatus["transport"];
  readers: ResidentStatus["readers"];
  models: ResidentStatus["models"];
  jobs: ResidentStatus["jobs"];
  generations: ResidentStatus["generations"];
  now?: number;
}

export function buildResidentStatusSnapshot(
  input: ResidentStatusSnapshotInput
): ResidentStatus {
  return {
    schemaVersion: "1.0",
    mode: input.mode,
    resident: true,
    uptimeSeconds: Math.max(
      0,
      Math.floor(((input.now ?? Date.now()) - input.startedAt) / 1000)
    ),
    listenerPort: input.listenerPort,
    admission: { ...input.admission },
    shutdown: { ...input.shutdown },
    transport: { ...input.transport },
    readers: { ...input.readers },
    models: { ...input.models },
    jobs: { ...input.jobs },
    generations: { ...input.generations },
  };
}

export function isResidentStatus(value: unknown): value is ResidentStatus {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ResidentStatus>;
  return (
    candidate.schemaVersion === "1.0" &&
    typeof candidate.mode === "string" &&
    typeof candidate.resident === "boolean" &&
    typeof candidate.admission === "object" &&
    candidate.admission !== null &&
    typeof candidate.transport === "object" &&
    candidate.transport !== null &&
    typeof candidate.models === "object" &&
    candidate.models !== null &&
    typeof candidate.jobs === "object" &&
    candidate.jobs !== null &&
    typeof candidate.generations === "object" &&
    candidate.generations !== null
  );
}
