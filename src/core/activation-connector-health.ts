import type {
  ActivationConnectorStatus,
  ActivationStatus,
  ConnectorOmittedSummary,
} from "./activation-status";

const NON_RUNTIME_CODES = new Set([
  "connector_not_configured",
  "target_runtime_unverifiable",
]);

export type ConnectorProofOutcome = keyof ConnectorOmittedSummary;

/** One shared reading of a connector pair, used for listed and unlisted pairs alike. */
export function classifyConnectorProof({
  code,
  status,
}: Pick<ActivationConnectorStatus, "code" | "status">): ConnectorProofOutcome {
  if (code !== undefined && NON_RUNTIME_CODES.has(code)) {
    return "notApplicable";
  }
  if (status === "passed" || status === "failed") {
    return status;
  }
  return "incomplete";
}

export function summarizeConnectorProofs(
  connectors: readonly Pick<ActivationConnectorStatus, "code" | "status">[]
): ConnectorOmittedSummary {
  const summary: ConnectorOmittedSummary = {
    passed: 0,
    failed: 0,
    incomplete: 0,
    notApplicable: 0,
  };
  for (const connector of connectors) {
    summary[classifyConnectorProof(connector)] += 1;
  }
  return summary;
}

/**
 * Summary of the pairs past the display cap, or null when some were omitted
 * without an evaluated result (fail closed).
 */
export function omittedConnectorSummary(
  activation: ActivationStatus
): ConnectorOmittedSummary | null {
  const { omitted, projected, total, truncated } =
    activation.connectorProjection;
  if (!truncated) {
    return { passed: 0, failed: 0, incomplete: 0, notApplicable: 0 };
  }
  if (!omitted) {
    return null;
  }
  const counted =
    omitted.passed +
    omitted.failed +
    omitted.incomplete +
    omitted.notApplicable;
  return counted === total - projected ? omitted : null;
}

/** Human summary of unlisted pairs, e.g. "108 passed, 1 failed". */
export function describeConnectorSummary(
  summary: ConnectorOmittedSummary
): string {
  const parts = [
    summary.passed > 0 ? `${summary.passed} passed` : null,
    summary.failed > 0 ? `${summary.failed} failed` : null,
    summary.incomplete > 0 ? `${summary.incomplete} pending` : null,
    summary.notApplicable > 0
      ? `${summary.notApplicable} not configured or not verifiable`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** Sentence describing the pairs past the display cap, or null when none were omitted. */
export function describeOmittedConnectorPairs(
  activation: ActivationStatus
): string | null {
  const { projected, total, truncated } = activation.connectorProjection;
  if (!truncated) {
    return null;
  }
  const omitted = total - projected;
  const summary = omittedConnectorSummary(activation);
  return summary
    ? `${omitted} more target/collection checks are not listed: ${describeConnectorSummary(summary)}.`
    : `${omitted} target/collection checks were omitted by the bounded status projection; no result is claimed for them.`;
}

/**
 * True when every collection/target pair, listed or not, passed or has a
 * non-runtime code. Pairs omitted without an evaluated result fail closed.
 */
export function isConnectorActivationComplete(
  activation: ActivationStatus
): boolean {
  const omitted = omittedConnectorSummary(activation);
  if (!omitted || omitted.failed > 0 || omitted.incomplete > 0) {
    return false;
  }
  return activation.connectors.every((connector) => {
    const outcome = classifyConnectorProof(connector);
    return outcome === "passed" || outcome === "notApplicable";
  });
}
