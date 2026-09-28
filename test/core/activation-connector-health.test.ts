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

  test("decides a truncated projection from the omitted summary", () => {
    const listed: ActivationStatus["connectors"] = [
      {
        collection: "notes",
        target: "cursor-mcp",
        status: "passed",
        remediation: "",
      },
    ];
    const withOmitted = (
      omitted: NonNullable<ActivationStatus["connectorProjection"]["omitted"]>,
      total = 4
    ): ActivationStatus => ({
      ...activation(listed),
      connectorProjection: {
        total,
        projected: listed.length,
        truncated: true,
        omitted,
      },
    });
    const clean = { passed: 2, failed: 0, incomplete: 0, notApplicable: 1 };

    expect(isConnectorActivationComplete(withOmitted(clean))).toBe(true);
    // A pending pair past the display cap keeps health incomplete.
    expect(
      isConnectorActivationComplete(
        withOmitted({ ...clean, passed: 1, incomplete: 1 })
      )
    ).toBe(false);
    // Counts that do not account for every unlisted pair fail closed.
    expect(isConnectorActivationComplete(withOmitted(clean, 5))).toBe(false);
    expect(
      isConnectorActivationComplete(withOmitted({ ...clean, passed: 1 }))
    ).toBe(false);
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
