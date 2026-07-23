/** Strict shared input normalization for every Context Capsule surface. */

import type { QueryModeInput } from "../pipeline/types";
import type { ContextCapsuleBuildInput } from "./context-runtime-types";

import { isValidLanguageHint } from "../config/types";
import { normalizeTag, validateTag } from "../core/tags";
import { resolveTemporalRange } from "../pipeline/temporal";
import { buildUri, parseUri } from "./constants";
import { ContextRuntimeError } from "./context-runtime-types";
import { canonicalizeIndexName } from "./index-name";

const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const QUERY_MODES = new Set(["term", "intent", "hyde"]);
const MAX_FILTER_VALUES = 128;
const MAX_FILTER_LENGTH = 256;
const MAX_TEXT_LENGTH = 16_384;
const DEFAULT_LIMIT = 20;
const DEFAULT_CANDIDATE_LIMIT = 40;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalStrings = (
  values: readonly string[] | undefined,
  label: string
): string[] => {
  if (
    values !== undefined &&
    (!Array.isArray(values) ||
      values.some((value) => typeof value !== "string"))
  ) {
    throw new ContextRuntimeError("invalid_filter", `${label} must be strings`);
  }
  return [
    ...new Set((values ?? []).map((value) => value.normalize("NFC").trim())),
  ].sort(compareCodeUnits);
};

const canonicalFilters = (
  values: readonly string[] | undefined,
  label: string
): string[] => {
  const normalized = canonicalStrings(values, label);
  if (
    normalized.length > MAX_FILTER_VALUES ||
    normalized.some(
      (value) =>
        value.length === 0 ||
        value.length > MAX_FILTER_LENGTH ||
        value.includes("\r")
    )
  ) {
    throw new ContextRuntimeError(
      "invalid_filter",
      `${label} contains an invalid value`
    );
  }
  return normalized;
};

const canonicalTagFilters = (
  values: readonly string[] | undefined,
  label: string
): string[] => {
  if (
    values !== undefined &&
    (!Array.isArray(values) ||
      values.some((value) => typeof value !== "string"))
  ) {
    throw new ContextRuntimeError("invalid_filter", `${label} must be strings`);
  }
  const normalized = [
    ...new Set((values ?? []).map((value) => normalizeTag(value))),
  ].sort(compareCodeUnits);
  if (
    normalized.length > MAX_FILTER_VALUES ||
    normalized.some(
      (value) =>
        value.length > MAX_FILTER_LENGTH ||
        value.includes("\r") ||
        !validateTag(value)
    )
  ) {
    throw new ContextRuntimeError(
      "invalid_filter",
      `${label} contains an invalid tag`
    );
  }
  return normalized;
};

const positiveSafeInteger = (
  value: number,
  label: string,
  code: "invalid_budget" | "invalid_filter" = "invalid_budget"
): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ContextRuntimeError(
      code,
      `${label} must be a positive safe integer`
    );
  }
  return value;
};

const canonicalQueryModes = (
  values: QueryModeInput[] | undefined
): QueryModeInput[] => {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_FILTER_VALUES) {
    throw new ContextRuntimeError("invalid_filter", "Invalid query modes");
  }
  const normalized = values.map((value) => {
    if (
      value === null ||
      typeof value !== "object" ||
      !QUERY_MODES.has(value.mode) ||
      typeof value.text !== "string"
    ) {
      throw new ContextRuntimeError("invalid_filter", "Invalid query mode");
    }
    const text = value.text.normalize("NFC").trim();
    if (!text || text.length > 4096 || text.includes("\r")) {
      throw new ContextRuntimeError(
        "invalid_filter",
        "Invalid query mode text"
      );
    }
    return { mode: value.mode, text };
  });
  if (normalized.filter((value) => value.mode === "hyde").length > 1) {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Only one hyde query mode is allowed"
    );
  }
  return normalized;
};

const validateUriPrefix = (
  value: string | null | undefined,
  indexName: string,
  collections: readonly string[]
): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ContextRuntimeError("invalid_uri", "URI prefix must be a string");
  }
  const parsed = parseUri(value);
  if (
    !parsed ||
    parsed.collection.length === 0 ||
    (parsed.indexName !== undefined &&
      canonicalizeIndexName(parsed.indexName) !== indexName) ||
    (collections.length > 0 && !collections.includes(parsed.collection))
  ) {
    throw new ContextRuntimeError(
      "invalid_uri",
      "URI prefix must be a canonical GNO reference inside the requested index and collections"
    );
  }
  if (buildUri(parsed.collection, parsed.path, { indexName }) !== value) {
    throw new ContextRuntimeError(
      "invalid_uri",
      "URI prefix must use its canonical indexed GNO representation"
    );
  }
  return value;
};

export const normalizeContextBuildInput = (
  input: ContextCapsuleBuildInput,
  defaultIndexName: string | undefined,
  now: Date,
  configuredCollectionNames?: readonly string[]
) => {
  if (!input || typeof input !== "object" || typeof input.goal !== "string") {
    throw new ContextRuntimeError("invalid_goal", "Context goal is required");
  }
  const rawQuery = input.query ?? input.goal;
  const goal = input.goal.normalize("NFC").trim();
  const query =
    typeof rawQuery === "string" ? rawQuery.normalize("NFC").trim() : "";
  if (
    !goal ||
    !query ||
    goal.length > MAX_TEXT_LENGTH ||
    query.length > MAX_TEXT_LENGTH ||
    goal.includes("\r") ||
    query.includes("\r")
  ) {
    throw new ContextRuntimeError(
      "invalid_goal",
      "Context goal and query must be non-empty canonical text"
    );
  }
  let indexName: string;
  try {
    indexName = canonicalizeIndexName(
      input.indexName ?? defaultIndexName ?? "default"
    );
  } catch (cause) {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Context index name is invalid",
      cause
    );
  }
  const collections = canonicalStrings(input.collections, "collections");
  if (
    collections.length > MAX_FILTER_VALUES ||
    collections.some((value) => !COLLECTION_PATTERN.test(value))
  ) {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Invalid collection filter"
    );
  }
  if (configuredCollectionNames) {
    const configured = new Set(configuredCollectionNames);
    const unknown = collections.find(
      (collection) => !configured.has(collection)
    );
    if (unknown) {
      throw new ContextRuntimeError(
        "invalid_filter",
        `Collection not found: ${unknown}`
      );
    }
    const prefixCollection =
      input.uriPrefix === undefined || input.uriPrefix === null
        ? null
        : parseUri(input.uriPrefix)?.collection;
    if (prefixCollection && !configured.has(prefixCollection)) {
      throw new ContextRuntimeError(
        "invalid_filter",
        `Collection not found: ${prefixCollection}`
      );
    }
  }
  const uriPrefix = validateUriPrefix(input.uriPrefix, indexName, collections);
  const budgetTokens = positiveSafeInteger(
    input.budgetTokens,
    "Context token budget"
  );
  const budgetBytes =
    input.budgetBytes === undefined
      ? Math.min(Number.MAX_SAFE_INTEGER, budgetTokens * 4)
      : positiveSafeInteger(input.budgetBytes, "Context byte budget");
  const safetyMarginTokens = input.safetyMarginTokens ?? 0;
  const safetyMarginBytes = input.safetyMarginBytes ?? 0;
  if (
    !Number.isSafeInteger(safetyMarginTokens) ||
    !Number.isSafeInteger(safetyMarginBytes) ||
    safetyMarginTokens < 0 ||
    safetyMarginBytes < 0 ||
    safetyMarginTokens >= budgetTokens ||
    safetyMarginBytes >= budgetBytes
  ) {
    throw new ContextRuntimeError(
      "invalid_budget",
      "Context safety margins must be non-negative and smaller than their budgets"
    );
  }
  if (
    (input.since !== undefined && typeof input.since !== "string") ||
    (input.until !== undefined && typeof input.until !== "string")
  ) {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Context date filters are invalid"
    );
  }
  const temporalRange = resolveTemporalRange(
    query,
    input.since,
    input.until,
    now
  );
  if (
    (input.since !== undefined && temporalRange.since === undefined) ||
    (input.until !== undefined && temporalRange.until === undefined) ||
    (temporalRange.since !== undefined &&
      temporalRange.until !== undefined &&
      temporalRange.since > temporalRange.until)
  ) {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Context date filters are invalid or reversed"
    );
  }
  const depthPolicy = input.depthPolicy ?? "balanced";
  if (!["fast", "balanced", "thorough"].includes(depthPolicy)) {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Invalid Context depth policy"
    );
  }
  const limit = input.limit ?? DEFAULT_LIMIT;
  const candidateLimit =
    input.candidateLimit ??
    (depthPolicy === "thorough"
      ? DEFAULT_CANDIDATE_LIMIT * 2
      : DEFAULT_CANDIDATE_LIMIT);
  positiveSafeInteger(limit, "Context result limit", "invalid_filter");
  positiveSafeInteger(
    candidateLimit,
    "Context candidate limit",
    "invalid_filter"
  );
  if (input.graph !== undefined && typeof input.graph !== "boolean") {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Context graph flag must be boolean"
    );
  }
  if (input.noRerank !== undefined && typeof input.noRerank !== "boolean") {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Context noRerank flag must be boolean"
    );
  }
  if (
    input.minScore !== undefined &&
    (typeof input.minScore !== "number" ||
      !Number.isFinite(input.minScore) ||
      input.minScore < 0 ||
      input.minScore > 1)
  ) {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Context minimum score must be between 0 and 1"
    );
  }
  const author =
    typeof input.author === "string"
      ? input.author.normalize("NFC").trim()
      : null;
  const lang =
    typeof input.lang === "string" ? input.lang.normalize("NFC").trim() : null;
  const intent =
    typeof input.intent === "string"
      ? input.intent.normalize("NFC").trim()
      : null;
  if (
    (input.author !== undefined &&
      (!author || author.length > MAX_FILTER_LENGTH)) ||
    (input.lang !== undefined && (!lang || !isValidLanguageHint(lang))) ||
    (input.intent !== undefined &&
      (!intent || intent.length > MAX_TEXT_LENGTH || intent.includes("\r")))
  ) {
    throw new ContextRuntimeError(
      "invalid_filter",
      "Context author or language filter is invalid"
    );
  }
  return {
    ...input,
    goal,
    query,
    indexName,
    collections,
    uriPrefix,
    queryModes: canonicalQueryModes(input.queryModes),
    tagsAll: canonicalTagFilters(input.tagsAll, "tagsAll"),
    tagsAny: canonicalTagFilters(input.tagsAny, "tagsAny"),
    categories: canonicalFilters(input.categories, "categories"),
    author,
    lang,
    intent,
    exclude: canonicalFilters(input.exclude, "exclude"),
    minScore: input.minScore ?? null,
    since: temporalRange.since,
    until: temporalRange.until,
    graph: input.graph ?? false,
    noRerank: input.noRerank ?? false,
    limit,
    candidateLimit,
    budgetTokens,
    budgetBytes,
    safetyMarginTokens,
    safetyMarginBytes,
    depthPolicy,
  };
};

export type NormalizedContextBuildInput = ReturnType<
  typeof normalizeContextBuildInput
>;
