export type HealthCheckStatus = "ok" | "warn" | "error";

export type HealthActionKind =
  | "add-collection"
  | "open-collections"
  | "sync"
  | "download-models"
  | "free-space";

export type OnboardingStepStatus = "complete" | "current" | "upcoming";

export interface StatusCollection {
  name: string;
  path: string;
  documentCount: number;
  chunkCount: number;
  embeddedCount: number;
}

export interface SuggestedCollection {
  label: string;
  path: string;
  reason: string;
}

export interface OnboardingStep {
  id: string;
  title: string;
  status: OnboardingStepStatus;
  detail: string;
}

export interface OnboardingState {
  ready: boolean;
  stage: "add-collection" | "models" | "indexing" | "ready";
  headline: string;
  detail: string;
  suggestedCollections: SuggestedCollection[];
  steps: OnboardingStep[];
}

export interface HealthCheck {
  id: string;
  title: string;
  status: HealthCheckStatus;
  summary: string;
  detail: string;
  actionLabel?: string;
  actionKind?: HealthActionKind;
}

export interface HealthCenterState {
  state: "healthy" | "needs-attention" | "setup-required";
  summary: string;
  checks: HealthCheck[];
}

export interface BackgroundServiceState {
  watcher: {
    expectedCollections: string[];
    activeCollections: string[];
    failedCollections: Array<{ collection: string; reason: string }>;
    queuedCollections: string[];
    syncingCollections: string[];
    lastEventAt: string | null;
    lastSyncAt: string | null;
  };
  embedding: {
    available: boolean;
    pendingDocCount: number;
    running: boolean;
    nextRunAt: number | null;
    lastRunAt: number | null;
    lastResult: { embedded: number; errors: number } | null;
  };
  events: {
    connectedClients: number;
    retryMs: number;
  };
}

export interface AppStatusResponse {
  indexName: string;
  configPath: string;
  dbPath: string;
  collections: StatusCollection[];
  totalDocuments: number;
  totalChunks: number;
  embeddingBacklog: number;
  lastUpdated: string | null;
  recentErrors: number;
  healthy: boolean;
  activePreset: {
    id: string;
    name: string;
  };
  capabilities: {
    bm25: boolean;
    vector: boolean;
    hybrid: boolean;
    answer: boolean;
  };
  onboarding: OnboardingState;
  health: HealthCenterState;
  background: BackgroundServiceState;
}
