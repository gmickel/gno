import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { AppStatusResponse } from "../../../../src/serve/status-model";

import { BootstrapStatus } from "../../../../src/serve/public/components/BootstrapStatus";

const minimalBootstrap = {
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
    activePresetName: "Slim",
    estimatedFootprint: null,
    downloading: false,
    cachedCount: 0,
    totalCount: 0,
    summary: "No model download required.",
    entries: [],
  },
} satisfies AppStatusResponse["bootstrap"];

describe("BootstrapStatus", () => {
  test("renders runtime, cache, and model readiness", () => {
    const html = renderToStaticMarkup(
      <BootstrapStatus
        activation={{
          schemaVersion: "1.0",
          usable: true,
          healthy: true,
          collections: [
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
                code: "models_missing",
                command: "gno models pull --embed",
              },
              remediation: null,
            },
          ],
          connectors: Array.from({ length: 64 }, (_, index) => ({
            collection: "notes",
            target: index === 0 ? "cursor-mcp" : `connector-${index}`,
            status: "failed" as const,
            code: "connector_timeout" as const,
            remediation: "Retry connector verification.",
          })),
          connectorProjection: {
            total: 85,
            projected: 64,
            truncated: true,
          },
        }}
        bootstrap={{
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
            path: "/Users/test/Library/Caches/gno",
            totalSizeBytes: 1234,
            totalSizeLabel: "1.2 KB",
          },
          models: {
            activePresetId: "slim",
            activePresetName: "Slim (Default, ~1GB)",
            estimatedFootprint: "~1GB",
            downloading: false,
            cachedCount: 2,
            totalCount: 4,
            summary: "2/4 preset roles are cached for Slim (Default, ~1GB).",
            entries: [
              {
                role: "embed",
                uri: "hf:embed",
                cached: true,
                path: "/tmp/embed.gguf",
                sizeBytes: 123,
                statusLabel: "Ready",
              },
              {
                role: "rerank",
                uri: "hf:rerank",
                cached: false,
                path: null,
                sizeBytes: null,
                statusLabel: "Needs download",
              },
              {
                role: "expand",
                uri: "hf:expand",
                cached: false,
                path: null,
                sizeBytes: null,
                statusLabel: "Needs download",
              },
              {
                role: "gen",
                uri: "hf:gen",
                cached: true,
                path: "/tmp/gen.gguf",
                sizeBytes: 123,
                statusLabel: "Ready",
              },
            ],
          },
        }}
        onDownloadModels={() => undefined}
      />
    );

    expect(html).toContain("Bootstrap &amp; Storage");
    expect(html).toContain("This beta runs on Bun 1.3.6.");
    expect(html).toContain("Models can auto-download on first use.");
    expect(html).toContain("Download missing models");
    expect(html).toContain("Needs download");
    expect(html).toContain("Lexical retrieval proven");
    expect(html).toContain("semantic models_missing");
    expect(html).toContain("Connector proof");
    expect(html).toContain("cursor-mcp");
    expect(html).toContain("failed/connector_timeout");
    expect(html.match(/failed\/connector_timeout/g)).toHaveLength(8);
    expect(html).toContain("+56 more projected checks");
    expect(html).toContain(
      "21 additional target/collection checks omitted from this bounded status view"
    );
    expect(html).not.toContain("+77 more");
    expect(html).not.toContain("text-emerald-500");
    expect(html).toContain("text-amber-500");
  });

  test("never renders a failed projected connector as green", () => {
    const html = renderToStaticMarkup(
      <BootstrapStatus
        activation={{
          schemaVersion: "1.0",
          usable: true,
          healthy: true,
          collections: [],
          connectors: [
            {
              collection: "notes",
              target: "cursor-mcp",
              status: "failed",
              code: "connector_timeout",
              remediation: "Retry connector verification.",
            },
          ],
          connectorProjection: {
            total: 1,
            projected: 1,
            truncated: false,
          },
        }}
        bootstrap={minimalBootstrap}
        onDownloadModels={() => undefined}
      />
    );

    expect(html).toContain("failed/connector_timeout");
    expect(html).toContain("text-amber-500");
    expect(html).not.toContain("text-emerald-500");
  });

  test("distinguishes unknown semantic state from explicit unavailability", () => {
    const baseCollection = {
      ready: true,
      generatedAt: "2026-07-22T10:00:00.000Z",
      stages: {
        index: {
          status: "passed" as const,
          startedAt: null,
          completedAt: null,
          latencyMs: 1,
        },
        lexical: {
          status: "passed" as const,
          startedAt: null,
          completedAt: null,
          latencyMs: 1,
        },
        semantic: {
          status: "pending" as const,
          startedAt: null,
          completedAt: null,
          latencyMs: null,
          code: "semantic_not_checked" as const,
        },
        connector: {
          status: "skipped" as const,
          startedAt: null,
          completedAt: null,
          latencyMs: null,
          code: "connector_not_requested" as const,
        },
      },
      remediation: null,
    };
    const html = renderToStaticMarkup(
      <BootstrapStatus
        activation={{
          schemaVersion: "1.0",
          usable: true,
          healthy: true,
          collections: [
            {
              ...baseCollection,
              collection: "unknown",
              semanticAvailability: {
                status: "pending",
                code: "semantic_not_checked",
                command: "gno status",
              },
            },
            {
              ...baseCollection,
              collection: "unavailable",
              semanticAvailability: {
                status: "skipped",
                code: "vector_unavailable",
                command: "gno doctor",
              },
            },
          ],
          connectors: [],
          connectorProjection: {
            total: 0,
            projected: 0,
            truncated: false,
          },
        }}
        bootstrap={minimalBootstrap}
        onDownloadModels={() => undefined}
      />
    );

    expect(html).toContain("unknown");
    expect(html).toContain("semantic semantic_not_checked");
    expect(html).toContain("unavailable");
    expect(html).toContain("semantic vector_unavailable");
    expect(html).not.toContain("semantic passed");
  });

  test("renders unprojected connector count when no pair is displayed", () => {
    const html = renderToStaticMarkup(
      <BootstrapStatus
        activation={{
          schemaVersion: "1.0",
          usable: true,
          healthy: true,
          collections: [],
          connectors: [],
          connectorProjection: {
            total: 2,
            projected: 0,
            truncated: true,
          },
        }}
        bootstrap={minimalBootstrap}
        onDownloadModels={() => undefined}
      />
    );

    expect(html).toContain(
      "2 additional target/collection checks omitted from this bounded status view"
    );
    expect(html).toContain("text-amber-500");
    expect(html).not.toContain("text-emerald-500");
  });
});
