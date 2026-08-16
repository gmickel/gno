/**
 * Resolve effective source-availability mode for a collection/index run.
 *
 * @module src/ingestion/source-availability/resolve
 */

import type { Collection } from "../../config/types";
import type { SyncOptions } from "../types";

import {
  DEFAULT_SOURCE_AVAILABILITY,
  type SourceAvailabilityMode,
} from "./types";

/**
 * Run-level SyncOptions override wins over collection config.
 * Missing values resolve to `any` (behaviorally unchanged default).
 */
export function resolveSourceAvailability(
  collection: Pick<Collection, "sourceAvailability">,
  options?: Pick<SyncOptions, "sourceAvailability">
): SourceAvailabilityMode {
  return (
    options?.sourceAvailability ??
    collection.sourceAvailability ??
    DEFAULT_SOURCE_AVAILABILITY
  );
}
