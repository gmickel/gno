/** UI-neutral health checks derived from the shared activation contract. */

import type { ActivationStatus } from "../core/activation-status";
import type { HealthCheck } from "./status-model";

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export function buildActivationCheck(
  activation: ActivationStatus
): HealthCheck {
  if (activation.healthy) {
    const semanticReasons = [
      ...new Set(
        activation.collections.map(
          ({ semanticAvailability }) => semanticAvailability.code
        )
      ),
    ];
    return {
      id: "retrieval-activation",
      title: "Retrieval proof",
      status: "ok",
      summary: `${countLabel(activation.collections.length, "folder")} passed lexical retrieval`,
      detail: `Lexical search is proven. Semantic availability is separate (${semanticReasons.join(", ")}).`,
      actionLabel: "Run update",
      actionKind: "sync",
    };
  }

  const failed = activation.collections.filter(({ ready }) => !ready);
  const first = failed[0];
  const detail = first?.remediation
    ? `${first.collection}: ${first.remediation.stage}/${first.remediation.code}. Run: ${first.remediation.command}`
    : "Add and index a supported text collection, then check retrieval again.";
  return {
    id: "retrieval-activation",
    title: "Retrieval proof",
    status: activation.usable ? "warn" : "error",
    summary: activation.usable
      ? `${countLabel(failed.length, "folder")} failed lexical retrieval`
      : "No folder passed lexical retrieval",
    detail,
    actionLabel: "Run update",
    actionKind: "sync",
  };
}

export function buildConnectorActivationCheck(
  activation: ActivationStatus
): HealthCheck | null {
  const observed = activation.connectors.filter(
    ({ code }) =>
      code !== "connector_not_configured" &&
      code !== "target_runtime_unverifiable"
  );
  if (observed.length === 0) {
    return null;
  }
  const failed = observed.filter(({ status }) => status === "failed");
  const incomplete = observed.filter(({ status }) => status !== "passed");
  const first = failed[0] ?? incomplete[0] ?? observed[0];
  return {
    id: "connector-activation",
    title: "Connector proof",
    status: failed.length > 0 ? "error" : incomplete.length > 0 ? "warn" : "ok",
    summary:
      failed.length > 0
        ? `${countLabel(failed.length, "connector proof")} failed`
        : incomplete.length > 0
          ? `${countLabel(incomplete.length, "connector proof")} incomplete`
          : `${countLabel(observed.length, "connector proof")} passed`,
    detail: first
      ? `${first.target} / ${first.collection}: ${first.status}${first.code ? `/${first.code}` : ""}${first.remediation ? `. ${first.remediation}` : ""}`
      : "No connector proof recorded.",
  };
}
