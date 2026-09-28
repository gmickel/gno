/**
 * Empty-collection rule shared by server surfaces and the Web UI bundle, so
 * it carries type imports only.
 */

import type { ActivationCollectionStatus } from "./activation-status";

/**
 * A collection with nothing indexed yet: its only activation problem is
 * `no_documents`. Surfaces show it as informational, never as a failure.
 */
export function isEmptyActivationCollection(
  collection: Pick<ActivationCollectionStatus, "ready" | "remediation">
): boolean {
  return !collection.ready && collection.remediation?.code === "no_documents";
}
