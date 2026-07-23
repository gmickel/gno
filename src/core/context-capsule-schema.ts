import { z } from "zod";

import { buildUri, deriveDocid, parseUri } from "../app/constants";
import { isValidIndexName } from "../app/index-name";
import { contextCapsuleIndexSnapshotSchema } from "./context-capsule-index-schema";
import { contextCapsuleRetrievalSchema } from "./context-capsule-retrieval-schema";
import {
  contextCapsuleEvidenceIdentity,
  contextCapsuleOmissionIdentity,
  sha256Text,
  validateContextCapsulePayload,
} from "./context-capsule-validation";

export { contextCapsuleIndexSnapshotSchema } from "./context-capsule-index-schema";

export const CONTEXT_CAPSULE_SCHEMA_VERSION = "1.0" as const;
export const CONTEXT_CAPSULE_COORDINATE_SPACE = "canonical_mirror" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const sha256Schema = z.string().regex(SHA256_PATTERN);
const nullableSha256Schema = sha256Schema.nullable();
const nullableDateSchema = z.string().datetime({ offset: true }).nullable();
const nullableDocumentDateSchema = z
  .union([z.string().date(), z.string().datetime({ offset: true })])
  .nullable();
const textSchema = z.string().max(16_384);
const nonEmptyTextSchema = textSchema.min(1);
const positiveIntegerSchema = z.number().int().positive();
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const collectionSchema = nonEmptyTextSchema.max(64).regex(COLLECTION_PATTERN);
const retrievalSourceSchema = z.enum([
  "bm25",
  "vector",
  "bm25_variant",
  "vector_variant",
  "hyde",
  "graph",
]);
const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isCanonicalCapsuleUri = (
  value: string,
  allowCollectionRoot: boolean
): boolean => {
  const parsed = parseUri(value);
  if (
    !parsed ||
    parsed.collection.length === 0 ||
    (!allowCollectionRoot && parsed.path.length === 0)
  ) {
    return false;
  }
  if (!COLLECTION_PATTERN.test(parsed.collection)) return false;
  if (parsed.indexName !== undefined && !isValidIndexName(parsed.indexName))
    return false;
  try {
    return (
      buildUri(parsed.collection, parsed.path, {
        indexName: parsed.indexName,
      }) === value
    );
  } catch {
    return false;
  }
};

export const contextCapsuleGnoUriSchema = z
  .string()
  .max(2048)
  .refine(
    (value) => isCanonicalCapsuleUri(value, false),
    "URI must be a canonical indexed GNO document reference"
  );

export const contextCapsulePrefixUriSchema = z
  .string()
  .max(2048)
  .refine(
    (value) => isCanonicalCapsuleUri(value, true),
    "URI must be a canonical indexed GNO prefix reference"
  );

export const contextCapsuleFallbackCodeSchema = z.enum([
  "embedding_unavailable",
  "reranking_unavailable",
  "graph_unavailable",
  "tokenizer_unavailable",
  "egress_policy_unavailable",
]);
export const contextCapsuleWarningCodeSchema = z.enum([
  "incomplete_coverage",
  "omissions_truncated",
  "token_estimate_used",
]);
export const contextCapsuleGapCodeSchema = z.enum([
  "facet_not_found",
  "global_budget_exhausted",
  "capability_unavailable",
  "filtered_by_scope",
]);
export const contextCapsuleOmissionCodeSchema = z.enum([
  "duplicate",
  "overlap",
  "global_budget",
  "redundant_coverage",
  "document_share_cap",
  "filtered_by_scope",
  "invalid_coordinates",
]);

const scopeSchema = z
  .object({
    indexName: nonEmptyTextSchema.max(64).refine(isValidIndexName),
    collections: z.array(collectionSchema).max(128),
    uriPrefix: contextCapsulePrefixUriSchema.nullable(),
    tagsAll: z.array(nonEmptyTextSchema.max(256)).max(128),
    tagsAny: z.array(nonEmptyTextSchema.max(256)).max(128),
    categories: z.array(nonEmptyTextSchema.max(256)).max(128),
    since: nullableDateSchema,
    until: nullableDateSchema,
  })
  .strict();

const budgetSchema = z
  .object({
    authority: z.literal("canonical_json"),
    requestedTokens: positiveIntegerSchema,
    requestedBytes: positiveIntegerSchema,
    safetyMarginTokens: nonNegativeIntegerSchema,
    safetyMarginBytes: nonNegativeIntegerSchema,
    usedTokens: positiveIntegerSchema,
    usedBytes: nonNegativeIntegerSchema,
    estimator: z.enum(["active_tokenizer", "unicode_conservative"]),
    tokenizerFingerprint: nullableSha256Schema,
  })
  .strict()
  .refine((value) => value.usedTokens <= value.requestedTokens, {
    message: "usedTokens cannot exceed requestedTokens",
    path: ["usedTokens"],
  })
  .refine((value) => value.usedBytes <= value.requestedBytes, {
    message: "usedBytes cannot exceed requestedBytes",
    path: ["usedBytes"],
  })
  .refine(
    (value) =>
      value.usedTokens + value.safetyMarginTokens <= value.requestedTokens,
    {
      message: "usedTokens and its safety margin cannot exceed requestedTokens",
      path: ["safetyMarginTokens"],
    }
  )
  .refine(
    (value) =>
      value.usedBytes + value.safetyMarginBytes <= value.requestedBytes,
    {
      message: "usedBytes and its safety margin cannot exceed requestedBytes",
      path: ["safetyMarginBytes"],
    }
  );

const capabilitiesSchema = z
  .object({
    lexicalSearch: z.literal(true),
    semanticSearch: z.boolean(),
    reranking: z.boolean(),
    graphExpansion: z.boolean(),
    exactTokenCount: z.boolean(),
    configuredContext: z.boolean(),
    egressPolicy: z.boolean(),
  })
  .strict();

const fallbackSchema = z
  .object({
    code: contextCapsuleFallbackCodeSchema,
    capability: z.enum([
      "semantic_search",
      "reranking",
      "graph_expansion",
      "token_count",
      "egress_policy",
    ]),
  })
  .strict();

const fingerprintsSchema = z
  .object({
    config: sha256Schema,
    retrieval: sha256Schema,
    embeddingModel: nullableSha256Schema,
    rerankModel: nullableSha256Schema,
    tokenizer: nullableSha256Schema,
  })
  .strict();

const guidanceSchema = z
  .object({
    extractiveOnly: z.literal(true),
    evidenceTrust: z.literal("untrusted_data"),
    instructionBoundary: z.literal("hard_delimited"),
    configuredContexts: z
      .array(
        z
          .object({
            contextId: sha256Schema,
            scopeType: z.enum(["global", "collection", "prefix"]),
            scopeKey: nonEmptyTextSchema.max(2048),
            text: nonEmptyTextSchema,
          })
          .strict()
          .superRefine((value, context) => {
            const valid =
              (value.scopeType === "global" && value.scopeKey === "/") ||
              (value.scopeType === "collection" &&
                /^[a-z0-9][a-z0-9_-]{0,63}:$/.test(value.scopeKey)) ||
              (value.scopeType === "prefix" &&
                contextCapsulePrefixUriSchema.safeParse(value.scopeKey)
                  .success);
            if (!valid) {
              context.addIssue({
                code: "custom",
                message: "configured context scopeKey is not canonical",
                path: ["scopeKey"],
              });
            }
          })
      )
      .max(128),
  })
  .strict();

export const contextCapsuleEvidenceSchema = z
  .object({
    evidenceId: sha256Schema,
    uri: contextCapsuleGnoUriSchema,
    docid: z.string().regex(/^#[a-f0-9]{6,}$/),
    collection: collectionSchema,
    title: textSchema.max(2048).nullable(),
    heading: textSchema.max(2048).nullable(),
    startLine: positiveIntegerSchema,
    endLine: positiveIntegerSchema,
    text: z.string().min(1),
    sourceHash: sha256Schema,
    mirrorHash: sha256Schema,
    passageHash: sha256Schema,
    modifiedAt: nullableDateSchema,
    documentDate: nullableDocumentDateSchema,
    observedAt: nullableDateSchema,
    contextIds: z.array(sha256Schema).max(128),
    retrievalRank: positiveIntegerSchema,
    selectionRank: positiveIntegerSchema,
    retrievalSources: z
      .array(retrievalSourceSchema)
      .min(1)
      .max(6)
      .refine((sources) => new Set(sources).size === sources.length, {
        message: "retrievalSources must be unique",
      })
      .optional(),
    graphExpanded: z.boolean().optional(),
    facets: z.array(nonEmptyTextSchema.max(512)).max(128),
    trust: z.literal("untrusted"),
    egress: z.enum([
      "local_only",
      "lan",
      "remote",
      "unclassified",
      "unavailable",
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endLine < value.startLine) {
      context.addIssue({
        code: "custom",
        message: "endLine must be greater than or equal to startLine",
        path: ["endLine"],
      });
    }
    if (value.text.includes("\r")) {
      context.addIssue({
        code: "custom",
        message: "evidence text must preserve canonical mirror LF bytes",
        path: ["text"],
      });
    }
    if (value.text.split("\n").length !== value.endLine - value.startLine + 1) {
      context.addIssue({
        code: "custom",
        message:
          "evidence text line count must match its inclusive coordinates",
        path: ["text"],
      });
    }
    if (sha256Text(value.text) !== value.passageHash) {
      context.addIssue({
        code: "custom",
        message: "passageHash must hash the exact evidence text bytes",
        path: ["passageHash"],
      });
    }
    if (deriveDocid(value.sourceHash) !== value.docid) {
      context.addIssue({
        code: "custom",
        message: "docid must be derived from sourceHash",
        path: ["docid"],
      });
    }
    if (contextCapsuleEvidenceIdentity(value) !== value.evidenceId) {
      context.addIssue({
        code: "custom",
        message:
          "evidenceId must bind the exact evidence coordinate and hashes",
        path: ["evidenceId"],
      });
    }
  });

const coveredFacetSchema = z
  .object({
    facet: nonEmptyTextSchema.max(512),
    evidenceIds: z.array(sha256Schema).min(1).max(256),
  })
  .strict();
const gapSchema = z
  .object({
    facet: nonEmptyTextSchema.max(512),
    code: contextCapsuleGapCodeSchema,
  })
  .strict();
const coverageSchema = z
  .object({
    complete: z.boolean(),
    requestedFacets: z.array(nonEmptyTextSchema.max(512)).max(128),
    coveredFacets: z.array(coveredFacetSchema).max(128),
    unresolvedFacets: z.array(nonEmptyTextSchema.max(512)).max(128),
    gaps: z.array(gapSchema).max(128),
  })
  .strict();

const omissionSchema = z
  .object({
    candidateId: sha256Schema,
    uri: contextCapsuleGnoUriSchema,
    docid: z.string().regex(/^#[a-f0-9]{6,}$/),
    startLine: positiveIntegerSchema.nullable(),
    endLine: positiveIntegerSchema.nullable(),
    passageHash: nullableSha256Schema,
    sourceHash: sha256Schema,
    mirrorHash: sha256Schema,
    reason: contextCapsuleOmissionCodeSchema,
  })
  .strict()
  .refine(
    (value) =>
      (value.startLine === null &&
        value.endLine === null &&
        value.passageHash === null) ||
      (value.startLine !== null &&
        value.endLine !== null &&
        value.endLine >= value.startLine &&
        value.passageHash !== null),
    {
      message:
        "omission coordinates and passageHash must be absent or complete",
      path: ["endLine"],
    }
  );

const omissionsSchema = z
  .object({
    total: nonNegativeIntegerSchema,
    items: z.array(omissionSchema).max(100),
    reasonCounts: z
      .object({
        duplicate: nonNegativeIntegerSchema,
        overlap: nonNegativeIntegerSchema,
        global_budget: nonNegativeIntegerSchema,
        redundant_coverage: nonNegativeIntegerSchema,
        document_share_cap: nonNegativeIntegerSchema,
        filtered_by_scope: nonNegativeIntegerSchema,
        invalid_coordinates: nonNegativeIntegerSchema,
      })
      .strict(),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.total < value.items.length) {
      context.addIssue({
        code: "custom",
        message: "invalid total",
        path: ["total"],
      });
    }
    if (value.truncated !== value.total > value.items.length) {
      context.addIssue({
        code: "custom",
        message: "truncated must reflect bounded omitted items",
        path: ["truncated"],
      });
    }
    const countedTotal = Object.values(value.reasonCounts).reduce(
      (sum, count) => sum + count,
      0
    );
    const visibleCounts = new Map<string, number>();
    for (const item of value.items) {
      visibleCounts.set(item.reason, (visibleCounts.get(item.reason) ?? 0) + 1);
    }
    if (
      countedTotal !== value.total ||
      [...visibleCounts].some(
        ([reason, count]) =>
          count > value.reasonCounts[reason as keyof typeof value.reasonCounts]
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "reasonCounts must account for every omitted candidate",
        path: ["reasonCounts"],
      });
    }
    const ids = value.items.map((item) => item.candidateId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "duplicate candidateId",
        path: ["items"],
      });
    }
    for (const [index, item] of value.items.entries()) {
      if (contextCapsuleOmissionIdentity(item) !== item.candidateId) {
        context.addIssue({
          code: "custom",
          message: "candidateId must bind the omitted candidate coordinate",
          path: ["items", index, "candidateId"],
        });
      }
      if (index > 0) {
        const previous = value.items[index - 1];
        const outOfOrder =
          previous !== undefined &&
          (compareCodeUnits(previous.reason, item.reason) ||
            compareCodeUnits(previous.uri, item.uri) ||
            (previous.startLine ?? 0) - (item.startLine ?? 0) ||
            compareCodeUnits(previous.candidateId, item.candidateId)) > 0;
        if (outOfOrder) {
          context.addIssue({
            code: "custom",
            message: "omission items must use canonical deterministic order",
            path: ["items", index],
          });
        }
      }
    }
  });

const warningSchema = z
  .object({ code: contextCapsuleWarningCodeSchema })
  .strict();

export const contextCapsulePayloadV1Schema = z
  .object({
    schemaVersion: z.literal(CONTEXT_CAPSULE_SCHEMA_VERSION),
    coordinateSpace: z.literal(CONTEXT_CAPSULE_COORDINATE_SPACE),
    goal: nonEmptyTextSchema,
    query: nonEmptyTextSchema,
    scope: scopeSchema,
    budget: budgetSchema,
    retrieval: contextCapsuleRetrievalSchema,
    fingerprints: fingerprintsSchema,
    capabilities: capabilitiesSchema,
    fallbacks: z.array(fallbackSchema).max(16),
    guidance: guidanceSchema,
    evidence: z.array(contextCapsuleEvidenceSchema).min(1),
    coverage: coverageSchema,
    omissions: omissionsSchema,
    truncated: z.boolean(),
    warnings: z.array(warningSchema).max(32),
  })
  .strict()
  .superRefine(validateContextCapsulePayload);

export type ContextCapsulePayloadV1 = z.infer<
  typeof contextCapsulePayloadV1Schema
>;
