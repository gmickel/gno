import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { buildConnectorActivationCheck } from "../../../../src/serve/activation-health";
import { HealthCenter } from "../../../../src/serve/public/components/HealthCenter";
import { createStandaloneResidentStatus } from "../../../../src/serve/resident-status";

describe("HealthCenter", () => {
  test("renders health checks and actions", () => {
    const html = renderToStaticMarkup(
      <HealthCenter
        health={{
          state: "needs-attention",
          summary: "GNO works, but a few issues still need attention.",
          checks: [
            {
              id: "models",
              title: "Models",
              status: "warn",
              summary:
                "Balanced is usable, but answer models are still missing",
              detail:
                "Core search is ready. Download the rest of the preset for best ranking and local AI answers.",
              actionLabel: "Download models",
              actionKind: "download-models",
            },
          ],
        }}
        onAction={() => undefined}
        resident={createStandaloneResidentStatus("direct-cli")}
      />
    );

    expect(html).toContain("Health Center");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Download models");
    expect(html).toContain("Balanced is usable");
  });

  test("renders failed lexical activation as blocked, never ready", () => {
    const html = renderToStaticMarkup(
      <HealthCenter
        health={{
          state: "setup-required",
          summary: "Lexical retrieval is not ready.",
          checks: [
            {
              id: "retrieval-activation",
              title: "Retrieval proof",
              status: "error",
              summary: "No folder passed lexical retrieval",
              detail:
                "notes: index/no_documents. Run: gno index notes --no-embed",
              actionLabel: "Run update",
              actionKind: "sync",
            },
          ],
        }}
        onAction={() => undefined}
        resident={createStandaloneResidentStatus("direct-cli")}
      />
    );

    expect(html).toContain("Blocked");
    expect(html).toContain("No folder passed lexical retrieval");
    expect(html).toContain("gno index notes --no-embed");
    expect(html).toContain("text-destructive");
    expect(html).not.toContain(">Ready<");
  });

  test("renders safe resident lifecycle counters without identities", () => {
    const resident = {
      ...createStandaloneResidentStatus("direct-cli"),
      mode: "serve" as const,
      resident: true,
      uptimeSeconds: 42,
      listenerPort: 3000,
      admission: { state: "accepting" as const, activeRequests: 2 },
      transport: {
        activeRequests: 2,
        activeSessions: 2,
        queuedRequests: 1,
        maxConcurrentRequests: 8,
        maxQueuedRequests: 4,
        maxSessions: 16,
      },
    };
    const html = renderToStaticMarkup(
      <HealthCenter
        health={{ state: "healthy", summary: "Ready.", checks: [] }}
        onAction={() => undefined}
        resident={resident}
      />
    );

    expect(html).toContain("Resident runtime");
    expect(html).toContain("3000");
    expect(html).toContain("2 +1 queued");
    expect(html).not.toContain("caller");
    expect(html).not.toContain("/Users/");
  });

  test("never labels an observed skipped connector proof as passed", () => {
    const check = buildConnectorActivationCheck({
      schemaVersion: "1.0",
      usable: false,
      healthy: false,
      collections: [],
      connectors: [
        {
          collection: "notes",
          target: "cursor-mcp",
          status: "skipped",
          code: "connector_probe_unavailable",
          remediation: "Repair lexical retrieval first.",
        },
      ],
      connectorProjection: { total: 1, projected: 1, truncated: false },
    });

    expect(check).toMatchObject({
      status: "warn",
      summary: "1 connector proof incomplete",
    });
  });

  test("never labels a truncated connector projection as healthy", () => {
    const check = buildConnectorActivationCheck({
      schemaVersion: "1.0",
      usable: true,
      healthy: true,
      collections: [],
      connectors: [
        {
          collection: "notes",
          target: "cursor-mcp",
          status: "passed",
          remediation: null,
        },
      ],
      connectorProjection: { total: 85, projected: 64, truncated: true },
    });

    expect(check).toMatchObject({
      status: "warn",
      summary: "64 of 85 connector target/collection checks projected",
    });
    expect(check?.detail).toContain("21 target/collection checks were omitted");
  });

  test("surfaces truncation even when no projected proof is observable", () => {
    const check = buildConnectorActivationCheck({
      schemaVersion: "1.0",
      usable: true,
      healthy: true,
      collections: [],
      connectors: [],
      connectorProjection: { total: 2, projected: 0, truncated: true },
    });

    expect(check).toMatchObject({
      status: "warn",
      summary: "0 of 2 connector target/collection checks projected",
    });
  });
});
