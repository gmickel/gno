import type { ActivationStatus } from "./activation-status";

const NON_RUNTIME_CODES = new Set([
  "connector_not_configured",
  "target_runtime_unverifiable",
]);

/** True when every observable proof passed and no target/collection pair was omitted. */
export function isConnectorActivationComplete(
  activation: ActivationStatus
): boolean {
  if (activation.connectorProjection.truncated) {
    return false;
  }
  return activation.connectors.every(
    ({ code, status }) =>
      (code !== undefined && NON_RUNTIME_CODES.has(code)) || status === "passed"
  );
}
