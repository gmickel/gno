import type { Config } from "../../../src/config/types";
import type { ActivationStatus } from "../../../src/core/activation-status";
import type { ServerContext } from "../../../src/serve/context";
import type { ActivationVerificationReceipt } from "../../../src/store/types";

export function activationStatus(
  collections: string[],
  ready = true
): ActivationStatus {
  return {
    schemaVersion: "1.0",
    usable: ready && collections.length > 0,
    healthy: ready && collections.length > 0,
    collections: collections.map((collection) => ({
      collection,
      ready,
      generatedAt: "2026-07-22T10:00:00.000Z",
      stages: {
        index: {
          status: ready ? "passed" : "failed",
          startedAt: null,
          completedAt: null,
          latencyMs: 1,
          ...(!ready ? { code: "no_documents" as const } : {}),
        },
        lexical: {
          status: ready ? "passed" : "skipped",
          startedAt: null,
          completedAt: null,
          latencyMs: 1,
          ...(!ready ? { code: "no_documents" as const } : {}),
        },
        semantic: {
          status: "pending",
          startedAt: null,
          completedAt: null,
          latencyMs: null,
          code: "semantic_not_checked",
        },
        connector: {
          status: "skipped",
          startedAt: null,
          completedAt: null,
          latencyMs: null,
          code: "connector_not_requested",
        },
      },
      semanticAvailability: {
        status: "pending",
        code: "semantic_not_checked",
        command: "gno status",
      },
      remediation: ready
        ? null
        : {
            stage: "index",
            code: "no_documents",
            command: `gno index ${collection} --no-embed`,
            message: "Index at least one supported text document.",
          },
    })),
    connectors: [],
    connectorProjection: { total: 0, projected: 0, truncated: false },
  };
}

export function createMockContext(): ServerContext {
  const config: Config = {
    version: "1.0",
    ftsTokenizer: "unicode61",
    collections: [],
    contexts: [],
    models: {
      activePreset: "slim-tuned",
      loadTimeout: 60_000,
      inferenceTimeout: 30_000,
      expandContextSize: 2_048,
      warmModelTtl: 300_000,
      presets: [
        {
          id: "slim-tuned",
          name: "GNO Slim Tuned (Default, ~1GB)",
          embed: "hf:embed",
          rerank: "hf:rerank",
          expand: "hf:expand",
          gen: "hf:gen",
        },
      ],
    },
  };

  return {
    config,
    indexName: "default",
    answerPort: null,
    capabilities: {
      answer: false,
      bm25: true,
      hybrid: false,
      vector: false,
    },
    embedPort: null,
    expandPort: null,
    rerankPort: null,
    store: {
      getStatus: async () => ({
        ok: true as const,
        value: {
          version: "1.0",
          indexName: "default",
          configPath: "/tmp/config.yml",
          dbPath: "/tmp/index.sqlite",
          ftsTokenizer: "unicode61",
          collections: [],
          totalDocuments: 0,
          activeDocuments: 0,
          totalChunks: 0,
          embeddingBacklog: 0,
          recentErrors: 0,
          lastUpdatedAt: null,
          healthy: true,
        },
      }),
    } as never,
    vectorIndex: null,
  };
}

export function configureReadyNotesContext(ctx: ServerContext): void {
  ctx.config.collections = [
    {
      name: "notes",
      path: "/tmp/notes",
      pattern: "**/*",
      include: [],
      exclude: [],
    },
  ];
  ctx.store = {
    getStatus: async () => ({
      ok: true as const,
      value: {
        version: "1.0",
        indexName: "default",
        configPath: "/tmp/config.yml",
        dbPath: "/tmp/index.sqlite",
        ftsTokenizer: "unicode61" as const,
        collections: [
          {
            name: "notes",
            path: "/tmp/notes",
            totalDocuments: 3,
            activeDocuments: 3,
            errorDocuments: 0,
            chunkedDocuments: 3,
            totalChunks: 12,
            embeddedChunks: 12,
          },
        ],
        totalDocuments: 3,
        activeDocuments: 3,
        totalChunks: 12,
        embeddingBacklog: 0,
        recentErrors: 0,
        lastUpdatedAt: "2026-07-22T10:00:00.000Z",
        healthy: true,
      },
    }),
  } as never;
}

export function readyVerificationReceipt(
  collection: string
): ActivationVerificationReceipt {
  const hash = "a".repeat(64);
  return {
    schemaVersion: "1.0",
    collection,
    fingerprint: hash,
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
      semantic: {
        status: "pending",
        startedAt: null,
        completedAt: null,
        latencyMs: null,
        code: "semantic_not_checked",
      },
      connector: {
        status: "skipped",
        startedAt: null,
        completedAt: null,
        latencyMs: null,
        code: "connector_not_requested",
      },
    },
    evidence: {
      probeHash: hash,
      resultUri: `gno://${collection}/proof.md`,
      resultSourceHash: hash,
    },
  };
}
