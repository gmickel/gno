/** Versioned normalized retrieval request and capability-state schema. */

import { z } from "zod";

import { contextCapsuleIndexSnapshotSchema } from "./context-capsule-index-schema";

const nonEmptyText = z.string().min(1);
const capabilityOutcomeSchema = z.enum([
  "not_requested",
  "not_attempted",
  "used",
  "unavailable",
]);

export const contextCapabilityStateSchema = z
  .object({
    requested: z.boolean(),
    attempted: z.boolean(),
    outcome: capabilityOutcomeSchema,
    fallbackReasons: z.array(nonEmptyText.max(256)).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const valid =
      (value.outcome === "not_requested" &&
        !value.requested &&
        !value.attempted &&
        value.fallbackReasons.length === 0) ||
      (value.outcome === "not_attempted" &&
        value.requested &&
        !value.attempted) ||
      (value.outcome === "used" && value.requested && value.attempted) ||
      (value.outcome === "unavailable" &&
        value.requested &&
        value.attempted &&
        value.fallbackReasons.length > 0);
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "requested, attempted, outcome, and fallback reasons disagree",
      });
    }
  });

const queryModeSchema = z
  .object({
    mode: z.enum(["term", "intent", "hyde"]),
    text: nonEmptyText.max(4096),
  })
  .strict();

export const contextCapsuleRetrievalSchema = z
  .object({
    depthPolicy: z.enum(["fast", "balanced", "thorough"]),
    facets: z.array(nonEmptyText.max(512)).max(128),
    queryVariants: z.array(nonEmptyText.max(4096)).min(1).max(128),
    expansionPolicy: z.literal("deterministic_only"),
    request: z
      .object({
        author: z.string().min(1).max(256).nullable(),
        lang: z.string().min(1).max(64).nullable(),
        queryModes: z.array(queryModeSchema).max(128),
        limit: z.number().int().positive(),
        candidateLimit: z.number().int().positive(),
        graphRequested: z.boolean(),
      })
      .strict(),
    capabilityStates: z
      .object({
        semanticSearch: contextCapabilityStateSchema,
        reranking: contextCapabilityStateSchema,
        graphExpansion: contextCapabilityStateSchema,
      })
      .strict(),
    indexSnapshot: contextCapsuleIndexSnapshotSchema,
  })
  .strict();

export type ContextCapabilityState = z.infer<
  typeof contextCapabilityStateSchema
>;
