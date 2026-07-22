import { describe, expect, mock, test } from "bun:test";

import type { Config } from "../../src/config/types";
import type {
  ActivationStageReceipt,
  ActivationVerificationReceipt,
  StorePort,
} from "../../src/store/types";

import { createDefaultConfig } from "../../src/config/defaults";
import {
  handleConnectors,
  handleVerifyConnector,
} from "../../src/serve/routes/api";
import { ok } from "../../src/store/types";

const skippedStage = (
  code:
    | "connector_not_requested"
    | "semantic_not_checked"
    | "target_runtime_unverifiable"
): ActivationStageReceipt => ({
  status: code === "semantic_not_checked" ? "pending" : "skipped",
  startedAt:
    code === "target_runtime_unverifiable" ? "2026-07-22T12:00:00.000Z" : null,
  completedAt:
    code === "target_runtime_unverifiable" ? "2026-07-22T12:00:00.000Z" : null,
  latencyMs: code === "target_runtime_unverifiable" ? 0 : null,
  code,
});

function configWithCollections(...names: string[]): Config {
  const config = createDefaultConfig();
  config.collections = names.map((name) => ({
    name,
    path: `/tmp/${name}`,
    pattern: "**/*",
    include: [],
    exclude: [],
  }));
  return config;
}

function connectorStatus(installKind: "mcp" | "skill" = "mcp") {
  return {
    id: installKind === "mcp" ? "cursor-mcp" : "codex-skill",
    appName: installKind === "mcp" ? "Cursor" : "Codex",
    installKind,
    target: installKind === "mcp" ? "cursor" : "codex",
    scope: "user" as const,
    installed: true,
    path: "/redacted/config",
    summary: "Installed.",
    nextAction: "Restart the client.",
    mode: { label: "Read/search", detail: "Read-only." },
  };
}

function verificationReceipt(
  connector: ActivationStageReceipt
): ActivationVerificationReceipt {
  return {
    schemaVersion: "1.0",
    collection: "notes",
    fingerprint: "f".repeat(64),
    ready: true,
    generatedAt: "2026-07-22T12:00:00.000Z",
    stages: {
      index: {
        status: "passed",
        startedAt: "2026-07-22T12:00:00.000Z",
        completedAt: "2026-07-22T12:00:00.000Z",
        latencyMs: 1,
      },
      lexical: {
        status: "passed",
        startedAt: "2026-07-22T12:00:00.000Z",
        completedAt: "2026-07-22T12:00:00.000Z",
        latencyMs: 1,
      },
      semantic: skippedStage("semantic_not_checked"),
      connector,
    },
    evidence: {
      probeHash: "b".repeat(64),
      resultUri: "gno://notes/proof.md",
      resultSourceHash: "c".repeat(64),
      connectorTarget: `mcp:cursor:user:${"e".repeat(64)}`,
    },
  };
}

function request(body: unknown): Request {
  return new Request("http://127.0.0.1/api/connectors/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("connector API", () => {
  test("passive listing exposes sorted collection names without running verification", async () => {
    const verify = mock(async () =>
      ok(verificationReceipt(skippedStage("connector_not_requested")))
    );
    const response = await handleConnectors(
      configWithCollections("zeta", "alpha"),
      undefined,
      {
        getStatuses: async () => [connectorStatus()],
        verify,
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      collections: ["alpha", "zeta"],
    });
    expect(verify).not.toHaveBeenCalled();
  });

  test("explicit verification invokes the connector once with a forced collection proof", async () => {
    const receipt = verificationReceipt({
      status: "passed",
      startedAt: "2026-07-22T12:00:00.000Z",
      completedAt: "2026-07-22T12:00:01.000Z",
      latencyMs: 1000,
    });
    const verify = mock(async () => ok(receipt));
    const store = {} as StorePort;
    const response = await handleVerifyConnector(
      configWithCollections("notes"),
      store,
      request({ connectorId: "cursor-mcp", collection: "notes" }),
      undefined,
      {
        getStatuses: async () => [connectorStatus()],
        verify,
      }
    );

    expect(response.status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(
      "cursor-mcp",
      store,
      "notes",
      { force: true },
      undefined
    );
    const body = await response.json();
    expect(body).toEqual({
      verification: {
        collection: "notes",
        lexicalReady: true,
        connectorReady: true,
        generatedAt: "2026-07-22T12:00:00.000Z",
        stages: { connector: receipt.stages.connector },
      },
      remediation: null,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /fingerprint|probeHash|resultUri|resultSourceHash|connectorTarget/
    );
  });

  test("keeps a failed connector proof distinct from lexical readiness", async () => {
    const receipt = verificationReceipt({
      status: "failed",
      startedAt: "2026-07-22T12:00:00.000Z",
      completedAt: "2026-07-22T12:00:01.000Z",
      latencyMs: 1000,
      code: "connector_timeout",
    });
    const response = await handleVerifyConnector(
      configWithCollections("notes"),
      {} as StorePort,
      request({ connectorId: "cursor-mcp", collection: "notes" }),
      undefined,
      {
        getStatuses: async () => [connectorStatus()],
        verify: async () => ok(receipt),
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      verification: {
        lexicalReady: true,
        connectorReady: false,
        stages: { connector: { status: "failed", code: "connector_timeout" } },
      },
    });
  });

  test("skill verification remains explicitly skipped with bounded remediation", async () => {
    const receipt = verificationReceipt(
      skippedStage("target_runtime_unverifiable")
    );
    const response = await handleVerifyConnector(
      configWithCollections("notes"),
      {} as StorePort,
      request({ connectorId: "codex-skill", collection: "notes" }),
      undefined,
      {
        getStatuses: async () => [connectorStatus("skill")],
        verify: async () => ok(receipt),
      }
    );
    const body = (await response.json()) as {
      verification: {
        stages: { connector: ActivationStageReceipt };
      };
      remediation: string;
    };

    expect(body.verification.stages.connector).toMatchObject({
      status: "skipped",
      code: "target_runtime_unverifiable",
    });
    expect(body.remediation).toContain("no safe read-only runtime");
  });

  test("rejects unknown fields, collections, and connector ids before verification", async () => {
    const verify = mock(async () =>
      ok(verificationReceipt(skippedStage("connector_not_requested")))
    );
    const deps = {
      getStatuses: async () => [connectorStatus()],
      verify,
    };
    const config = configWithCollections("notes");
    const store = {} as StorePort;

    const unknownField = await handleVerifyConnector(
      config,
      store,
      request({ connectorId: "cursor-mcp", collection: "notes", force: true }),
      undefined,
      deps
    );
    const unknownCollection = await handleVerifyConnector(
      config,
      store,
      request({ connectorId: "cursor-mcp", collection: "secrets" }),
      undefined,
      deps
    );
    const invalidConnector = await handleVerifyConnector(
      config,
      store,
      request({ connectorId: 42, collection: "notes" }),
      undefined,
      deps
    );
    const unknownConnector = await handleVerifyConnector(
      config,
      store,
      request({ connectorId: "other", collection: "notes" }),
      undefined,
      deps
    );

    expect(unknownField.status).toBe(400);
    expect(await unknownField.json()).toMatchObject({
      error: { code: "VALIDATION", message: "Request body has unknown fields" },
    });
    expect(unknownCollection.status).toBe(400);
    expect(await invalidConnector.json()).toMatchObject({
      error: { code: "VALIDATION", message: "Missing or invalid connectorId" },
    });
    expect(unknownConnector.status).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });

  test("redacts verifier failures from the API error", async () => {
    const response = await handleVerifyConnector(
      configWithCollections("notes"),
      {} as StorePort,
      request({ connectorId: "cursor-mcp", collection: "notes" }),
      undefined,
      {
        getStatuses: async () => [connectorStatus()],
        verify: async () => {
          throw new Error("secret child stderr /Users/gordon/private");
        },
      }
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(serialized).toContain("CONNECTOR_VERIFICATION_FAILED");
    expect(serialized).not.toContain("secret child stderr");
    expect(serialized).not.toContain("/Users/gordon/private");
  });
});
