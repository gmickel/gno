/** Canonical replay-filter parsing shared by qrels export and replay. */

import type { StoreResult } from "../store/types";

import { err, ok } from "../store/types";
import { traceFiltersSchema } from "./retrieval-trace";

const SET_ARRAY_KEYS = [
  "categories",
  "collections",
  "exclude",
  "tagsAll",
  "tagsAny",
] as const;

export type RetrievalTraceFilters = Record<string, unknown>;

export const parseRetrievalTraceFilters = (
  value: unknown
): StoreResult<RetrievalTraceFilters> => {
  const parsed = traceFiltersSchema.safeParse(value);
  if (!parsed.success) {
    return err("INVALID_INPUT", `filters_incomplete: ${parsed.error.message}`);
  }
  const normalized: RetrievalTraceFilters = { ...parsed.data };
  for (const key of SET_ARRAY_KEYS) {
    const values = parsed.data[key];
    if (values) normalized[key] = [...new Set(values)].sort();
  }
  return ok(normalized);
};
