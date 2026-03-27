import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BootstrapStatus } from "../../../../src/serve/public/components/BootstrapStatus";

describe("BootstrapStatus", () => {
  test("renders runtime, cache, and model readiness", () => {
    const html = renderToStaticMarkup(
      <BootstrapStatus
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
  });
});
