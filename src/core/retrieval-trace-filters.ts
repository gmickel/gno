/** Canonical replay-filter parsing shared by qrels export and replay. */

import type { StoreResult } from "../store/types";

import { err, ok } from "../store/types";
import { traceFiltersSchema } from "./retrieval-trace";
import { canonicalizeRetrievalTraceFilters } from "./retrieval-trace-filter-normalization";

export type RetrievalTraceFilters = Record<string, unknown>;

export const parseRetrievalTraceFilters = (
  value: unknown
): StoreResult<RetrievalTraceFilters> => {
  const parsed = traceFiltersSchema.safeParse(value);
  if (!parsed.success) {
    return err("INVALID_INPUT", `filters_incomplete: ${parsed.error.message}`);
  }
  return ok(canonicalizeRetrievalTraceFilters(parsed.data));
};
