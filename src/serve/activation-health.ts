/** UI-neutral health checks derived from the shared activation contract. */

import type { ActivationStatus } from "../core/activation-status";
import type { HealthCheck } from "./status-model";

import {
  classifyConnectorProof,
  describeOmittedConnectorPairs,
  omittedConnectorSummary,
} from "../core/activation-connector-health";
import { isEmptyActivationCollection } from "../core/activation-empty";

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export function buildActivationCheck(
  activation: ActivationStatus
): HealthCheck {
  const ready = activation.collections.filter((collection) => collection.ready);
  const empty = activation.collections.filter(isEmptyActivationCollection);
  const emptyDetail =
    empty.length > 0
      ? `${countLabel(empty.length, "folder")} ${empty.length === 1 ? "has" : "have"} no documents yet (${empty.map(({ collection }) => collection).join(", ")}): add files, then run update.`
      : null;
  if (activation.healthy) {
    const semanticReasons = [
      ...new Set(
        ready.map(({ semanticAvailability }) => semanticAvailability.code)
      ),
    ];
    const semanticDetail =
      ready.length > 0
        ? `Lexical search is proven. Semantic availability is separate (${semanticReasons.join(", ")}).`
        : null;
    return {
      id: "retrieval-activation",
      title: "Retrieval proof",
      status: "ok",
      summary:
        ready.length === 0
          ? `No documents indexed yet in ${countLabel(empty.length, "folder")}`
          : empty.length > 0
            ? `${countLabel(ready.length, "folder")} passed lexical retrieval; ${countLabel(empty.length, "folder")} with no documents yet`
            : `${countLabel(ready.length, "folder")} passed lexical retrieval`,
      detail: [semanticDetail, emptyDetail].filter(Boolean).join(" "),
      actionLabel: "Run update",
      actionKind: "sync",
    };
  }

  const failed = activation.collections.filter(
    (collection) =>
      !collection.ready && !isEmptyActivationCollection(collection)
  );
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
    detail: [detail, emptyDetail].filter(Boolean).join(" "),
    actionLabel: "Run update",
    actionKind: "sync",
  };
}

export function buildConnectorActivationCheck(
  activation: ActivationStatus
): HealthCheck | null {
  const { projected, total, truncated } = activation.connectorProjection;
  const omitted = omittedConnectorSummary(activation);
  const observed = activation.connectors.filter(
    (connector) => classifyConnectorProof(connector) !== "notApplicable"
  );
  const omittedObserved = omitted
    ? omitted.passed + omitted.failed + omitted.incomplete
    : 0;
  if (observed.length === 0 && omittedObserved === 0 && omitted) {
    return null;
  }
  const failed = observed.filter(({ status }) => status === "failed");
  const incomplete = observed.filter(({ status }) => status !== "passed");
  const failedCount = failed.length + (omitted?.failed ?? 0);
  const incompleteCount =
    incomplete.length + (omitted?.incomplete ?? 0) + (omitted?.failed ?? 0);
  const passedCount =
    observed.length - incomplete.length + (omitted?.passed ?? 0);
  const first = failed[0] ?? incomplete[0] ?? observed[0];
  const firstDetail = first
    ? `${first.target} / ${first.collection}: ${first.status}${first.code ? `/${first.code}` : ""}${first.remediation ? `. ${first.remediation}` : ""}`
    : null;
  const projectionDetail = describeOmittedConnectorPairs(activation);
  const listing = truncated ? ` (${projected} of ${total} checks listed)` : "";
  return {
    id: "connector-activation",
    title: "Connector proof",
    status:
      failedCount > 0
        ? "error"
        : incompleteCount > 0 || !omitted
          ? "warn"
          : "ok",
    summary:
      failedCount > 0
        ? `${countLabel(failedCount, "connector proof")} failed${listing}`
        : incompleteCount > 0
          ? `${countLabel(incompleteCount, "connector proof")} incomplete${listing}`
          : omitted
            ? `${countLabel(passedCount, "connector proof")} passed${listing}`
            : `${projected} of ${total} connector target/collection checks projected`,
    detail: [projectionDetail, firstDetail].filter(Boolean).join(" "),
  };
}
