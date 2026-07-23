/** Closed runtime validation for the shared retrieval replay boundary. */

import { z } from "zod";

import type { StoreResult } from "../store/types";
import type { ReplayRetrievalTraceInput } from "./retrieval-replay-types";

import { err, ok } from "../store/types";

const MAX_REPLAY_RESULTS = 10_000;
const queryModeTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(8192)
  .refine((value) => !value.includes("\r"), {
    message: "Replay query mode text must not contain carriage returns",
  })
  .transform((value) => value.normalize("NFC"))
  .pipe(z.string().min(1).max(8192));
const queryModeSchema = z
  .object({
    mode: z.enum(["term", "intent", "hyde"]),
    text: queryModeTextSchema,
  })
  .strict();
const candidateSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    type: z.enum(["bm25", "vector", "hybrid"]),
    limit: z
      .number()
      .finite()
      .int()
      .positive()
      .max(MAX_REPLAY_RESULTS)
      .optional(),
    candidateLimit: z
      .number()
      .finite()
      .int()
      .positive()
      .max(MAX_REPLAY_RESULTS)
      .optional(),
    noExpand: z.boolean().optional(),
    noRerank: z.boolean().optional(),
    queryModes: z
      .array(queryModeSchema)
      .max(100)
      .superRefine((modes, context) => {
        const seen = new Set<string>();
        let hydeCount = 0;
        for (const [index, mode] of modes.entries()) {
          const key = `${mode.mode}\0${mode.text}`;
          if (seen.has(key)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "Replay queryModes must be unique",
            });
          }
          seen.add(key);
          if (mode.mode === "hyde") hydeCount += 1;
        }
        if (hydeCount > 1) {
          context.addIssue({
            code: "custom",
            message: "Replay queryModes allow at most one hyde mode",
          });
        }
      })
      .optional(),
  })
  .strict();
const replayInputSchema = z
  .object({
    exportId: z.string().trim().min(1).max(128),
    candidate: candidateSchema,
  })
  .strict();

export const parseReplayRetrievalTraceInput = (
  input: unknown
): StoreResult<ReplayRetrievalTraceInput> => {
  const parsed = replayInputSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err("INVALID_INPUT", "Invalid retrieval replay input", parsed.error);
};
