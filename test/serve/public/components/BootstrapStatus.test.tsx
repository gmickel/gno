import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BootstrapStatus } from "../../../../src/serve/public/components/BootstrapStatus";

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
    expect(html).toContain("+56 more projected checks");
    expect(html).toContain(
      "21 additional target/collection checks omitted from this bounded status view"
    );
    expect(html).not.toContain("+77 more");
  });
});
