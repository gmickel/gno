import { z } from "zod";

import { canonicalizeIndexName } from "../app/index-name";
import {
  contextCapsulePayloadV1Schema,
  type ContextCapsulePayloadV1,
} from "./context-capsule-schema";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const canonicalizeJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) {
        throw new Error(`Canonical JSON rejects undefined at ${key}`);
      }
      sorted[key] = canonicalizeJsonValue(child);
    }
    return sorted;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Canonical JSON rejects non-finite numbers");
  }
  return value;
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalizeJsonValue(value));
const utf8Bytes = (value: string): number =>
  new TextEncoder().encode(value).byteLength;
const hashCanonical = (value: unknown): string =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");
const normalizeText = (value: string): string =>
  value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");
const normalizeDate = (value: string | null): string | null =>
  value === null ? null : new Date(value).toISOString();
const normalizeDocumentDate = (value: string | null): string | null =>
  value === null || /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : new Date(value).toISOString();
const normalizeSet = (values: readonly string[]): string[] =>
  [...new Set(values.map(normalizeText))].sort(compareCodeUnits);

const normalizePayload = (
  value: ContextCapsulePayloadV1
): ContextCapsulePayloadV1 => ({
  ...value,
  goal: normalizeText(value.goal),
  query: normalizeText(value.query),
  scope: {
    ...value.scope,
    indexName: canonicalizeIndexName(value.scope.indexName),
    collections: normalizeSet(value.scope.collections),
    uriPrefix:
      value.scope.uriPrefix === null
        ? null
        : normalizeText(value.scope.uriPrefix),
    tagsAll: normalizeSet(value.scope.tagsAll),
    tagsAny: normalizeSet(value.scope.tagsAny),
    categories: normalizeSet(value.scope.categories),
    since: normalizeDate(value.scope.since),
    until: normalizeDate(value.scope.until),
  },
  retrieval: {
    ...value.retrieval,
    facets: normalizeSet(value.retrieval.facets),
    queryVariants: value.retrieval.queryVariants.map(normalizeText),
    request: {
      ...value.retrieval.request,
      author:
        value.retrieval.request.author === null
          ? null
          : normalizeText(value.retrieval.request.author),
      lang:
        value.retrieval.request.lang === null
          ? null
          : normalizeText(value.retrieval.request.lang),
      queryModes: value.retrieval.request.queryModes.map((mode) => ({
        ...mode,
        text: normalizeText(mode.text),
      })),
    },
    capabilityStates: Object.fromEntries(
      Object.entries(value.retrieval.capabilityStates).map(([key, state]) => [
        key,
        { ...state, fallbackReasons: normalizeSet(state.fallbackReasons) },
      ])
    ) as typeof value.retrieval.capabilityStates,
  },
  fallbacks: [...value.fallbacks].sort((left, right) =>
    compareCodeUnits(
      `${left.code}\0${left.capability}`,
      `${right.code}\0${right.capability}`
    )
  ),
  evidence: value.evidence.map((item) => ({
    ...item,
    title: item.title === null ? null : normalizeText(item.title),
    heading: item.heading === null ? null : normalizeText(item.heading),
    modifiedAt: normalizeDate(item.modifiedAt),
    documentDate: normalizeDocumentDate(item.documentDate),
    observedAt: normalizeDate(item.observedAt),
    contextIds: normalizeSet(item.contextIds),
    facets: normalizeSet(item.facets),
  })),
  guidance: {
    ...value.guidance,
    configuredContexts: [...value.guidance.configuredContexts]
      .map((item) => ({
        ...item,
        scopeKey: normalizeText(item.scopeKey),
        text: normalizeText(item.text),
      }))
      .sort((left, right) => compareCodeUnits(left.contextId, right.contextId)),
  },
  coverage: {
    ...value.coverage,
    requestedFacets: normalizeSet(value.coverage.requestedFacets),
    coveredFacets: [...value.coverage.coveredFacets]
      .map((item) => ({
        facet: normalizeText(item.facet),
        evidenceIds: normalizeSet(item.evidenceIds),
      }))
      .sort((left, right) => compareCodeUnits(left.facet, right.facet)),
    unresolvedFacets: normalizeSet(value.coverage.unresolvedFacets),
    gaps: [...value.coverage.gaps].sort((left, right) =>
      compareCodeUnits(
        `${left.facet}\0${left.code}`,
        `${right.facet}\0${right.code}`
      )
    ),
  },
  warnings: [...value.warnings].sort((left, right) =>
    compareCodeUnits(left.code, right.code)
  ),
});

export type ContextCapsuleErrorCode =
  | "identity_mismatch"
  | "index_changed_during_compile"
  | "invalid_budget"
  | "invalid_input"
  | "no_evidence"
  | "tokenizer_unavailable";

export class ContextCapsuleContractError extends Error {
  readonly code: ContextCapsuleErrorCode;

  constructor(
    code: ContextCapsuleErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ContextCapsuleContractError";
    this.code = code;
  }
}

const contractError = (
  input: unknown,
  error: unknown
): ContextCapsuleContractError => {
  const record =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const evidence = record.evidence;
  const retrieval = record.retrieval as Record<string, unknown> | undefined;
  const snapshot = retrieval?.indexSnapshot as
    | Record<string, unknown>
    | undefined;
  if (Array.isArray(evidence) && evidence.length === 0) {
    return new ContextCapsuleContractError(
      "no_evidence",
      "Context Capsule requires evidence",
      {
        cause: error,
      }
    );
  }
  if (snapshot?.before !== snapshot?.after || snapshot?.stable === false) {
    return new ContextCapsuleContractError(
      "index_changed_during_compile",
      "Index changed while Context Capsule compilation was running",
      { cause: error }
    );
  }
  if (record.budget !== undefined) {
    const budget = record.budget as Record<string, unknown>;
    if (
      typeof budget.usedBytes !== "number" ||
      typeof budget.requestedBytes !== "number" ||
      typeof budget.safetyMarginBytes !== "number" ||
      typeof budget.usedTokens !== "number" ||
      typeof budget.requestedTokens !== "number" ||
      typeof budget.safetyMarginTokens !== "number" ||
      budget.safetyMarginBytes < 0 ||
      budget.safetyMarginTokens < 0 ||
      budget.usedBytes > budget.requestedBytes ||
      budget.usedTokens > budget.requestedTokens ||
      budget.usedBytes + budget.safetyMarginBytes > budget.requestedBytes ||
      budget.usedTokens + budget.safetyMarginTokens > budget.requestedTokens
    ) {
      return new ContextCapsuleContractError(
        "invalid_budget",
        "Invalid Context Capsule budget",
        {
          cause: error,
        }
      );
    }
  }
  return new ContextCapsuleContractError(
    "invalid_input",
    "Invalid Context Capsule payload",
    {
      cause: error,
    }
  );
};

const parsePayload = (input: unknown): ContextCapsulePayloadV1 => {
  try {
    return contextCapsulePayloadV1Schema.parse(input);
  } catch (error) {
    throw contractError(input, error);
  }
};

export interface ContextCapsuleCreateOptions {
  countTokens?: (accountingJson: string) => number;
}

const identityPayload = (payload: ContextCapsulePayloadV1) => {
  const {
    usedBytes: _usedBytes,
    usedTokens: _usedTokens,
    ...stableBudget
  } = payload.budget;
  return { ...payload, budget: stableBudget };
};

const accountingPayload = <T extends ContextCapsulePayloadV1>(value: T) => {
  const {
    usedBytes: _usedBytes,
    usedTokens: _usedTokens,
    ...budget
  } = value.budget;
  return { ...value, budget };
};

const activeTokenCount = (
  accountingJson: string,
  options: ContextCapsuleCreateOptions
): number => {
  const count = options.countTokens?.(accountingJson);
  if (count === undefined || !Number.isSafeInteger(count) || count < 1) {
    throw new ContextCapsuleContractError(
      "invalid_budget",
      "Active-tokenizer Capsules require a positive deterministic token counter"
    );
  }
  return count;
};

const fixedPointCapsule = (
  payloadInput: ContextCapsulePayloadV1,
  options: ContextCapsuleCreateOptions
) => {
  const capsuleId = hashCanonical(identityPayload(payloadInput));
  const stableCapsule = { ...payloadInput, capsuleId };
  const exactTokens =
    payloadInput.budget.estimator === "active_tokenizer"
      ? activeTokenCount(
          canonicalJson(accountingPayload(stableCapsule)),
          options
        )
      : null;
  let payload = {
    ...payloadInput,
    budget: {
      ...payloadInput.budget,
      usedBytes: 0,
      usedTokens: exactTokens ?? 1,
    },
  };
  const visited = new Set<string>();
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const capsule = { ...payload, capsuleId };
    const canonical = canonicalJson(capsule);
    const measuredBytes = utf8Bytes(canonical);
    const tokenCount = exactTokens ?? measuredBytes;
    if (
      measuredBytes === payload.budget.usedBytes &&
      tokenCount === payload.budget.usedTokens
    ) {
      return capsule;
    }
    const state = `${measuredBytes}:${tokenCount}`;
    if (visited.has(state)) break;
    visited.add(state);
    payload = {
      ...payload,
      budget: {
        ...payload.budget,
        usedBytes: measuredBytes,
        usedTokens: tokenCount,
      },
    };
  }
  throw new ContextCapsuleContractError(
    "invalid_budget",
    "Canonical Context Capsule budget did not converge"
  );
};

const contextCapsuleBaseV1Schema = contextCapsulePayloadV1Schema.extend({
  capsuleId: sha256Schema,
});

export const contextCapsuleV1Schema = contextCapsuleBaseV1Schema.superRefine(
  (value, context) => {
    const { capsuleId, ...payload } = value;
    if (hashCanonical(identityPayload(payload)) !== capsuleId) {
      context.addIssue({
        code: "custom",
        message: "capsuleId does not match payload",
        path: ["capsuleId"],
      });
    }
    if (utf8Bytes(canonicalJson(value)) !== value.budget.usedBytes) {
      context.addIssue({
        code: "custom",
        message: "usedBytes must equal canonical Capsule JSON UTF-8 bytes",
        path: ["budget", "usedBytes"],
      });
    }
    if (
      value.budget.estimator === "unicode_conservative" &&
      value.budget.usedTokens !== value.budget.usedBytes
    ) {
      context.addIssue({
        code: "custom",
        message: "unicode-conservative usedTokens must equal final usedBytes",
        path: ["budget", "usedTokens"],
      });
    }
  }
);

export type ContextCapsuleV1 = z.infer<typeof contextCapsuleV1Schema>;

export const contextCapsuleId = (
  input: unknown,
  options: ContextCapsuleCreateOptions = {}
): string => createContextCapsuleV1(input, options).capsuleId;

export const createContextCapsuleV1 = (
  input: unknown,
  options: ContextCapsuleCreateOptions = {}
): ContextCapsuleV1 => {
  const parsed = normalizePayload(parsePayload(input));
  const capsule = fixedPointCapsule(parsed, options);
  if (
    capsule.budget.usedBytes + capsule.budget.safetyMarginBytes >
      capsule.budget.requestedBytes ||
    capsule.budget.usedTokens + capsule.budget.safetyMarginTokens >
      capsule.budget.requestedTokens
  ) {
    throw new ContextCapsuleContractError(
      "invalid_budget",
      "Canonical Context Capsule JSON exceeds its global budget"
    );
  }
  return contextCapsuleV1Schema.parse(capsule);
};

export const parseContextCapsuleV1 = (
  input: unknown,
  options: ContextCapsuleCreateOptions = {}
): ContextCapsuleV1 => {
  try {
    const parsed = contextCapsuleBaseV1Schema.parse(input);
    const { capsuleId, ...payloadInput } = parsed;
    const payload = normalizePayload(payloadInput);
    const canonical = { ...payload, capsuleId };
    const result = contextCapsuleV1Schema.safeParse(canonical);
    if (!result.success) {
      throw new ContextCapsuleContractError(
        result.error.issues.some((issue) => issue.path.includes("capsuleId"))
          ? "identity_mismatch"
          : "invalid_budget",
        "Context Capsule canonical identity or budget does not match its payload",
        { cause: result.error }
      );
    }
    if (
      result.data.budget.estimator === "active_tokenizer" &&
      options.countTokens !== undefined
    ) {
      const recounted = activeTokenCount(
        canonicalJson(accountingPayload(result.data)),
        options
      );
      if (recounted !== result.data.budget.usedTokens) {
        throw new ContextCapsuleContractError(
          "invalid_budget",
          "usedTokens does not match the active-tokenizer accounting projection"
        );
      }
    }
    return result.data;
  } catch (error) {
    if (error instanceof ContextCapsuleContractError) throw error;
    throw contractError(input, error);
  }
};

export const canonicalContextCapsuleJson = (input: unknown): string =>
  canonicalJson(parseContextCapsuleV1(input));

export const canonicalContextCapsuleAccountingJson = (input: unknown): string =>
  canonicalJson(accountingPayload(parseContextCapsuleV1(input)));

export {
  contextCapsuleVerificationEvidenceSchema,
  contextCapsuleVerificationSchema,
  type ContextCapsuleVerification,
} from "./context-capsule-verification";
