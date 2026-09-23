import { z } from "zod";

import { sha256Schema } from "./manifest";

const id = z.string().min(1);
const count = z.number().int().nonnegative();
export const evidenceStages = [
  "retrieval",
  "fusion",
  "rerank_input",
  "delivery",
] as const;
export type EvidenceStage = (typeof evidenceStages)[number];

export const evidenceFixturesSchema = z.strictObject({
  schemaVersion: z.literal("gno-evidence-fixtures-v1"),
  documents: z
    .array(
      z.strictObject({
        uri: id,
        title: id,
        content: id,
        sourceHash: sha256Schema,
      })
    )
    .min(1),
  spans: z
    .array(
      z.strictObject({
        id,
        uri: id,
        sourceHash: sha256Schema,
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        spanHash: sha256Schema,
      })
    )
    .min(1),
  cases: z
    .array(
      z.strictObject({
        caseId: id,
        family: id,
        query: id,
        intent: id.nullable(),
        collection: id,
        tokenBudget: z.number().int().positive(),
        byteBudget: z.number().int().positive(),
        requiredSets: z.array(z.array(id).min(1)),
        expectAbstention: z.boolean(),
        expectedValues: z.array(id),
        mustCover: z.boolean(),
        split: z.enum(["development", "held-out"]),
      })
    )
    .min(1),
});
export type EvidenceFixtures = z.infer<typeof evidenceFixturesSchema>;
export type EvidenceCase = EvidenceFixtures["cases"][number];

export const observedPassageSchema = z.strictObject({
  uri: id,
  sourceHash: sha256Schema,
  start: count,
  end: count,
  text: z.string(),
  inputId: id,
  // The original selected extent, before clipping; null means not observed.
  selectedEnd: count.nullable(),
});
export type ObservedPassage = z.infer<typeof observedPassageSchema>;
const stage = z.array(observedPassageSchema).nullable();
export const evidenceObservationSchema = z.strictObject({
  caseId: id,
  arm: z.enum(["current", "noExpand"]),
  fixtureSha256: sha256Schema,
  identitySha256: sha256Schema,
  noExpand: z.boolean(),
  tokenBudget: z.number().int().positive(),
  byteBudget: z.number().int().positive(),
  coverage: z.enum(["complete", "incomplete"]),
  reasons: z.array(id),
  stages: z.strictObject({
    retrieval: stage,
    fusion: stage,
    rerank_input: stage,
    delivery: stage,
  }),
  reader: z
    .strictObject({
      answer: z.string(),
      abstained: z.boolean(),
      verified: z.boolean(),
    })
    .nullable(),
  cost: z.strictObject({
    visibleBytes: count,
    usedTokens: count,
    estimator: z.enum(["unicode_conservative", "active_tokenizer"]),
    readerOutputBytes: count.nullable().default(null),
    readerOutputTokens: count.nullable().default(null),
    tokenizations: z
      .array(
        z.strictObject({
          modelId: id,
          inputSha256: sha256Schema,
          count,
        })
      )
      .nullable(),
    durationMs: z.number().finite().nonnegative(),
    rssBytes: count.nullable(),
  }),
});
export type EvidenceObservation = z.infer<typeof evidenceObservationSchema>;
export const evidenceRunSchema = z.strictObject({
  schemaVersion: z.literal("gno-evidence-run-v1"),
  kind: z.enum(["replay", "native"]),
  observations: z.array(evidenceObservationSchema).min(1),
});

export const spanOutcomeSchema = z.enum([
  "complete",
  "partial",
  "clipped",
  "split-across-inputs",
  "missing",
  "unknown",
]);
export type SpanOutcome = z.infer<typeof spanOutcomeSchema>;
const stageScore = z.strictObject({
  all: z.boolean().nullable(),
  any: z.boolean().nullable(),
  spans: z.record(id, spanOutcomeSchema),
});
export const evidenceScoreSchema = z.strictObject({
  caseId: id,
  arm: z.enum(["current", "noExpand"]),
  valid: z.boolean(),
  reasons: z.array(id),
  stages: z.strictObject({
    retrieval: stageScore,
    fusion: stageScore,
    rerank_input: stageScore,
    delivery: stageScore,
  }),
  firstLossStage: z.enum(evidenceStages).nullable(),
  groundedTaskSuccess: z.boolean().nullable(),
  correctAbstention: z.boolean().nullable(),
  cost: evidenceObservationSchema.shape.cost,
});
export type EvidenceScore = z.infer<typeof evidenceScoreSchema>;
export const evidenceReportSchema = z.strictObject({
  schemaVersion: z.literal("gno-evidence-report-v1"),
  kind: z.enum(["replay", "native"]),
  fixtureSha256: sha256Schema,
  valid: z.boolean(),
  passed: z.boolean(),
  reasons: z.array(id),
  scores: z.array(evidenceScoreSchema),
  paired: z.array(
    z.strictObject({
      caseId: id,
      allEvidenceDelta: z.number().int().min(-1).max(1).nullable(),
      groundedTaskDelta: z.number().int().min(-1).max(1).nullable(),
      baselineMiss: z.boolean(),
      candidateMiss: z.boolean(),
    })
  ),
});
