import { describe, expect, test } from "bun:test";

import type { ActivationStatus } from "../../src/core/activation-status";

import { isConnectorActivationComplete } from "../../src/core/activation-connector-health";

function activation(
  connectors: ActivationStatus["connectors"],
  truncated = false
): ActivationStatus {
  return {
    schemaVersion: "1.0",
    usable: true,
    healthy: true,
    collections: [],
    connectors,
    connectorProjection: {
      total: connectors.length + (truncated ? 1 : 0),
      projected: connectors.length,
      truncated,
    },
  };
}

describe("connector activation completeness", () => {
  test("fails closed for observed incomplete or omitted proofs", () => {
    expect(
      isConnectorActivationComplete(
        activation([
          {
            collection: "notes",
            target: "cursor-mcp",
            status: "failed",
            code: "connector_search_failed",
            remediation: "Repeat verification.",
          },
        ])
      )
    ).toBe(false);
    expect(isConnectorActivationComplete(activation([], true))).toBe(false);
  });

  test("ignores absent configs and unverifiable skill runtimes", () => {
    expect(
      isConnectorActivationComplete(
        activation([
          {
            collection: "notes",
            target: "codex-skill",
            status: "skipped",
            code: "target_runtime_unverifiable",
            remediation: "Verify from the client.",
          },
          {
            collection: "notes",
            target: "cursor-mcp",
            status: "skipped",
            code: "connector_not_configured",
            remediation: "Install the connector.",
          },
        ])
      )
    ).toBe(true);
  });
});
