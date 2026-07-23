import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

const activation = {
  schemaVersion: "1.0",
  usable: false,
  healthy: false,
  collections: [],
  connectors: [],
  connectorProjection: { total: 0, projected: 0, truncated: false },
} as const;

const pendingStage = {
  status: "pending",
  startedAt: null,
  completedAt: null,
  latencyMs: null,
  code: "semantic_not_checked",
} as const;

const resident = {
  schemaVersion: "1.0",
  mode: "serve",
  resident: true,
  uptimeSeconds: 60,
  listenerPort: 3000,
  admission: { state: "accepting", activeRequests: 0 },
  shutdown: { state: "none" },
  transport: {
    activeRequests: 0,
    activeSessions: 0,
    queuedRequests: 0,
    maxConcurrentRequests: 64,
    maxQueuedRequests: 16,
    maxSessions: 32,
  },
  readers: { active: 0, queued: 0, limit: 8, maxQueued: 64 },
  models: {
    activeLeases: 0,
    leaseAcquisitions: 1,
    leaseReleases: 1,
    loadedModels: 1,
    loadAttempts: 1,
    loadSuccesses: 1,
    loadFailures: 0,
    inflightLoads: 0,
  },
  jobs: { active: 0, recent: 1, failed: 0 },
  generations: { content: 2, index: 1 },
} as const;

describe("status schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("status");
  });

  describe("valid inputs", () => {
    test("validates healthy status fixture", async () => {
      const fixture = await Bun.file(
        "test/fixtures/outputs/status-healthy.json"
      ).json();
      expect(assertValid(fixture, schema)).toBe(true);
    });

    test("validates minimal status", () => {
      const status = {
        resident,
        indexName: "default",
        collections: [],
        totalDocuments: 0,
        totalChunks: 0,
        embeddingBacklog: 0,
        recentErrors: 0,
        healthy: true,
        activePreset: {
          id: "slim",
          name: "Slim (Default, ~1GB)",
        },
        capabilities: {
          bm25: true,
          vector: false,
          hybrid: false,
          answer: false,
        },
        activation,
        onboarding: {
          ready: false,
          stage: "add-collection",
          headline: "Start by connecting the folders you care about",
          detail: "Pick notes, docs, or a project directory.",
          suggestedCollections: [],
          steps: [],
        },
        health: {
          state: "setup-required",
          summary: "Finish first-run setup.",
          checks: [],
        },
        background: {
          watcher: {
            expectedCollections: [],
            activeCollections: [],
            failedCollections: [],
            queuedCollections: [],
            syncingCollections: [],
            lastEventAt: null,
            lastSyncAt: null,
          },
          embedding: {
            available: false,
            pendingDocCount: 0,
            running: false,
            nextRunAt: null,
            lastRunAt: null,
            lastResult: null,
          },
          events: {
            connectedClients: 0,
            retryMs: 0,
          },
        },
        bootstrap: {
          runtime: {
            kind: "bun",
            strategy: "manual-install-beta",
            currentVersion: "1.3.6",
            requiredVersion: ">=1.3.0",
            ready: true,
            managedByApp: false,
            summary: "This beta runs on Bun 1.3.6.",
            detail: "Current beta installs still expect Bun to be present.",
          },
          policy: {
            offline: false,
            allowDownload: true,
            source: "default",
            summary: "Models can auto-download on first use.",
          },
          cache: {
            path: "/tmp/cache",
            totalSizeBytes: 0,
            totalSizeLabel: "0 B",
          },
          models: {
            activePresetId: "slim",
            activePresetName: "Slim (Default, ~1GB)",
            estimatedFootprint: "~1GB",
            downloading: false,
            cachedCount: 0,
            totalCount: 4,
            summary: "0/4 preset roles are cached for Slim (Default, ~1GB).",
            entries: [],
          },
        },
      };
      expect(assertValid(status, schema)).toBe(true);
    });

    test("validates status with single collection", () => {
      const status = {
        resident,
        indexName: "test",
        collections: [
          {
            name: "docs",
            path: "/path/to/docs",
            documentCount: 10,
            chunkCount: 50,
            embeddedCount: 50,
          },
        ],
        totalDocuments: 10,
        totalChunks: 50,
        embeddingBacklog: 0,
        recentErrors: 0,
        healthy: true,
        activePreset: {
          id: "balanced",
          name: "Balanced (~2GB)",
        },
        capabilities: {
          bm25: true,
          vector: true,
          hybrid: true,
          answer: true,
        },
        activation: { ...activation, usable: true, healthy: true },
        onboarding: {
          ready: false,
          stage: "indexing",
          headline: "GNO is almost ready.",
          detail: "Run the first sync to populate the index.",
          suggestedCollections: [],
          steps: [],
        },
        health: {
          state: "needs-attention",
          summary: "GNO works, but a few issues still need attention.",
          checks: [],
        },
        background: {
          watcher: {
            expectedCollections: ["docs"],
            activeCollections: ["docs"],
            failedCollections: [],
            queuedCollections: [],
            syncingCollections: [],
            lastEventAt: null,
            lastSyncAt: null,
          },
          embedding: {
            available: true,
            pendingDocCount: 1,
            running: false,
            nextRunAt: null,
            lastRunAt: null,
            lastResult: null,
          },
          events: {
            connectedClients: 1,
            retryMs: 2000,
          },
        },
        bootstrap: {
          runtime: {
            kind: "bun",
            strategy: "manual-install-beta",
            currentVersion: "1.3.6",
            requiredVersion: ">=1.3.0",
            ready: true,
            managedByApp: false,
            summary: "This beta runs on Bun 1.3.6.",
            detail: "Current beta installs still expect Bun to be present.",
          },
          policy: {
            offline: false,
            allowDownload: true,
            source: "default",
            summary: "Models can auto-download on first use.",
          },
          cache: {
            path: "/tmp/cache",
            totalSizeBytes: 1024,
            totalSizeLabel: "1 KB",
          },
          models: {
            activePresetId: "balanced",
            activePresetName: "Balanced (~2GB)",
            estimatedFootprint: "~2GB",
            downloading: false,
            cachedCount: 2,
            totalCount: 4,
            summary: "2/4 preset roles are cached for Balanced (~2GB).",
            entries: [],
          },
        },
      };
      expect(assertValid(status, schema)).toBe(true);
    });

    test("validates unhealthy status", () => {
      const status = {
        resident,
        indexName: "default",
        collections: [],
        totalDocuments: 0,
        totalChunks: 0,
        embeddingBacklog: 100,
        recentErrors: 2,
        healthy: false,
        activePreset: {
          id: "slim",
          name: "Slim (Default, ~1GB)",
        },
        capabilities: {
          bm25: true,
          vector: false,
          hybrid: false,
          answer: false,
        },
        activation,
        onboarding: {
          ready: false,
          stage: "models",
          headline: "Finish model setup next",
          detail: "Download the active preset.",
          suggestedCollections: [],
          steps: [],
        },
        health: {
          state: "setup-required",
          summary: "Finish first-run setup.",
          checks: [],
        },
        background: {
          watcher: {
            expectedCollections: [],
            activeCollections: [],
            failedCollections: [],
            queuedCollections: [],
            syncingCollections: [],
            lastEventAt: null,
            lastSyncAt: null,
          },
          embedding: {
            available: false,
            pendingDocCount: 0,
            running: false,
            nextRunAt: null,
            lastRunAt: null,
            lastResult: null,
          },
          events: {
            connectedClients: 0,
            retryMs: 0,
          },
        },
        bootstrap: {
          runtime: {
            kind: "bun",
            strategy: "manual-install-beta",
            currentVersion: "1.3.6",
            requiredVersion: ">=1.3.0",
            ready: true,
            managedByApp: false,
            summary: "This beta runs on Bun 1.3.6.",
            detail: "Current beta installs still expect Bun to be present.",
          },
          policy: {
            offline: true,
            allowDownload: false,
            source: "gno-offline",
            summary: "Offline mode. Cached models only.",
          },
          cache: {
            path: "/tmp/cache",
            totalSizeBytes: 0,
            totalSizeLabel: "0 B",
          },
          models: {
            activePresetId: "slim",
            activePresetName: "Slim (Default, ~1GB)",
            estimatedFootprint: "~1GB",
            downloading: false,
            cachedCount: 0,
            totalCount: 4,
            summary: "0/4 preset roles are cached for Slim (Default, ~1GB).",
            entries: [],
          },
        },
      };
      expect(assertValid(status, schema)).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    test("rejects contradictory semantic availability states", async () => {
      const status = await Bun.file(
        "test/fixtures/outputs/status-healthy.json"
      ).json();
      status.activation.collections = [
        {
          collection: "notes",
          ready: true,
          generatedAt: "2026-07-22T10:00:00.000Z",
          stages: {
            index: {
              status: "passed",
              startedAt: null,
              completedAt: null,
              latencyMs: 1,
            },
            lexical: {
              status: "passed",
              startedAt: null,
              completedAt: null,
              latencyMs: 1,
            },
            semantic: pendingStage,
            connector: {
              ...pendingStage,
              status: "skipped",
              code: "connector_not_requested",
            },
          },
          semanticAvailability: {
            status: "pending",
            code: "vector_unavailable",
            command: "gno doctor",
          },
          remediation: null,
        },
      ];

      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects corpus-bearing fields at the status root", async () => {
      const status = await Bun.file(
        "test/fixtures/outputs/status-healthy.json"
      ).json();
      status.rawCorpus = "must not cross the status boundary";

      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects corpus-bearing fields outside the activation projection", async () => {
      const status = await Bun.file(
        "test/fixtures/outputs/status-healthy.json"
      ).json();
      status.activation.collections = [
        {
          collection: "notes",
          ready: false,
          generatedAt: null,
          stages: {
            index: {
              ...pendingStage,
              code: "index_query_failed",
              rawSnippet: "must not cross the status boundary",
            },
            lexical: pendingStage,
            semantic: pendingStage,
            connector: { ...pendingStage, code: "connector_not_requested" },
          },
          semanticAvailability: {
            status: "pending",
            code: "models_missing",
            command: "gno models pull --embed",
          },
          remediation: {
            stage: "index",
            code: "index_query_failed",
            command: "gno index notes --no-embed",
            message: "Repair the index.",
          },
        },
      ];

      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects missing indexName", () => {
      const status = {
        collections: [],
        totalDocuments: 0,
        totalChunks: 0,
        embeddingBacklog: 0,
        healthy: true,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects missing collections array", () => {
      const status = {
        indexName: "default",
        totalDocuments: 0,
        totalChunks: 0,
        embeddingBacklog: 0,
        recentErrors: 0,
        healthy: true,
        activePreset: {
          id: "slim",
          name: "Slim (Default, ~1GB)",
        },
        capabilities: {
          bm25: true,
          vector: false,
          hybrid: false,
          answer: false,
        },
        onboarding: {
          ready: false,
          stage: "add-collection",
          headline: "Start by connecting the folders you care about",
          detail: "Pick notes, docs, or a project directory.",
          suggestedCollections: [],
          steps: [],
        },
        health: {
          state: "setup-required",
          summary: "Finish first-run setup.",
          checks: [],
        },
        background: {
          watcher: {
            expectedCollections: [],
            activeCollections: [],
            failedCollections: [],
            queuedCollections: [],
            syncingCollections: [],
            lastEventAt: null,
            lastSyncAt: null,
          },
          embedding: {
            available: false,
            pendingDocCount: 0,
            running: false,
            nextRunAt: null,
            lastRunAt: null,
            lastResult: null,
          },
          events: {
            connectedClients: 0,
            retryMs: 0,
          },
        },
        bootstrap: {
          runtime: {
            kind: "bun",
            strategy: "manual-install-beta",
            currentVersion: "1.3.6",
            requiredVersion: ">=1.3.0",
            ready: true,
            managedByApp: false,
            summary: "This beta runs on Bun 1.3.6.",
            detail: "Current beta installs still expect Bun to be present.",
          },
          policy: {
            offline: false,
            allowDownload: true,
            source: "default",
            summary: "Models can auto-download on first use.",
          },
          cache: {
            path: "/tmp/cache",
            totalSizeBytes: 0,
            totalSizeLabel: "0 B",
          },
          models: {
            activePresetId: "slim",
            activePresetName: "Slim (Default, ~1GB)",
            estimatedFootprint: "~1GB",
            downloading: false,
            cachedCount: 0,
            totalCount: 4,
            summary: "0/4 preset roles are cached for Slim (Default, ~1GB).",
            entries: [],
          },
        },
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects collection missing required fields", () => {
      const status = {
        indexName: "default",
        collections: [{ name: "docs" }],
        totalDocuments: 0,
        totalChunks: 0,
        embeddingBacklog: 0,
        healthy: true,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects negative document count", () => {
      const status = {
        indexName: "default",
        collections: [],
        totalDocuments: -1,
        totalChunks: 0,
        embeddingBacklog: 0,
        recentErrors: 0,
        healthy: true,
        activePreset: {
          id: "slim",
          name: "Slim (Default, ~1GB)",
        },
        capabilities: {
          bm25: true,
          vector: false,
          hybrid: false,
          answer: false,
        },
        onboarding: {
          ready: false,
          stage: "add-collection",
          headline: "Start by connecting the folders you care about",
          detail: "Pick notes, docs, or a project directory.",
          suggestedCollections: [],
          steps: [],
        },
        health: {
          state: "setup-required",
          summary: "Finish first-run setup.",
          checks: [],
        },
        background: {
          watcher: {
            expectedCollections: [],
            activeCollections: [],
            failedCollections: [],
            queuedCollections: [],
            syncingCollections: [],
            lastEventAt: null,
            lastSyncAt: null,
          },
          embedding: {
            available: false,
            pendingDocCount: 0,
            running: false,
            nextRunAt: null,
            lastRunAt: null,
            lastResult: null,
          },
          events: {
            connectedClients: 0,
            retryMs: 0,
          },
        },
        bootstrap: {
          runtime: {
            kind: "bun",
            strategy: "manual-install-beta",
            currentVersion: "1.3.6",
            requiredVersion: ">=1.3.0",
            ready: true,
            managedByApp: false,
            summary: "This beta runs on Bun 1.3.6.",
            detail: "Current beta installs still expect Bun to be present.",
          },
          policy: {
            offline: false,
            allowDownload: true,
            source: "default",
            summary: "Models can auto-download on first use.",
          },
          cache: {
            path: "/tmp/cache",
            totalSizeBytes: 0,
            totalSizeLabel: "0 B",
          },
          models: {
            activePresetId: "slim",
            activePresetName: "Slim (Default, ~1GB)",
            estimatedFootprint: "~1GB",
            downloading: false,
            cachedCount: 0,
            totalCount: 4,
            summary: "0/4 preset roles are cached for Slim (Default, ~1GB).",
            entries: [],
          },
        },
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects missing healthy field", () => {
      const status = {
        indexName: "default",
        collections: [],
        totalDocuments: 0,
        totalChunks: 0,
        embeddingBacklog: 0,
        recentErrors: 0,
        activePreset: {
          id: "slim",
          name: "Slim (Default, ~1GB)",
        },
        capabilities: {
          bm25: true,
          vector: false,
          hybrid: false,
          answer: false,
        },
        onboarding: {
          ready: false,
          stage: "add-collection",
          headline: "Start by connecting the folders you care about",
          detail: "Pick notes, docs, or a project directory.",
          suggestedCollections: [],
          steps: [],
        },
        health: {
          state: "setup-required",
          summary: "Finish first-run setup.",
          checks: [],
        },
        background: {
          watcher: {
            expectedCollections: [],
            activeCollections: [],
            failedCollections: [],
            queuedCollections: [],
            syncingCollections: [],
            lastEventAt: null,
            lastSyncAt: null,
          },
          embedding: {
            available: false,
            pendingDocCount: 0,
            running: false,
            nextRunAt: null,
            lastRunAt: null,
            lastResult: null,
          },
          events: {
            connectedClients: 0,
            retryMs: 0,
          },
        },
        bootstrap: {
          runtime: {
            kind: "bun",
            strategy: "manual-install-beta",
            currentVersion: "1.3.6",
            requiredVersion: ">=1.3.0",
            ready: true,
            managedByApp: false,
            summary: "This beta runs on Bun 1.3.6.",
            detail: "Current beta installs still expect Bun to be present.",
          },
          policy: {
            offline: false,
            allowDownload: true,
            source: "default",
            summary: "Models can auto-download on first use.",
          },
          cache: {
            path: "/tmp/cache",
            totalSizeBytes: 0,
            totalSizeLabel: "0 B",
          },
          models: {
            activePresetId: "slim",
            activePresetName: "Slim (Default, ~1GB)",
            estimatedFootprint: "~1GB",
            downloading: false,
            cachedCount: 0,
            totalCount: 4,
            summary: "0/4 preset roles are cached for Slim (Default, ~1GB).",
            entries: [],
          },
        },
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });
  });
});
