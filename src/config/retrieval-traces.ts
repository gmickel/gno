/** Opt-in retrieval trace configuration and bounded-retention defaults. */

import { z } from "zod";

export const RETRIEVAL_TRACE_DEFAULT_RETENTION = {
  maxAgeDays: 30,
  maxTraces: 1_000,
  maxRecordsPerTrace: 10_000,
  maxBytes: 16 * 1024 * 1024,
} as const;

export const RetrievalTraceRetentionSchema = z
  .object({
    maxAgeDays: z.number().int().min(1).max(3_650),
    maxTraces: z.number().int().min(1).max(1_000_000),
    maxRecordsPerTrace: z.number().int().min(1).max(100_000),
    maxBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(1024 * 1024 * 1024),
  })
  .strict();

export const RetrievalTraceRedactionModeSchema = z.enum(["metadata", "replay"]);

const DisabledRetrievalTraceConfigSchema = z
  .object({
    enabled: z.literal(false),
  })
  .strict();

const EnabledRetrievalTraceConfigSchema = z
  .object({
    enabled: z.literal(true),
    /**
     * `replay` stores replay inputs such as the raw query and filters. Choosing
     * it is explicit consent; the safer metadata-only projection is recommended.
     */
    redactionMode: RetrievalTraceRedactionModeSchema,
    retention: RetrievalTraceRetentionSchema,
  })
  .strict();

export const RetrievalTraceConfigSchema = z.discriminatedUnion("enabled", [
  DisabledRetrievalTraceConfigSchema,
  EnabledRetrievalTraceConfigSchema,
]);

export type RetrievalTraceConfig = z.infer<typeof RetrievalTraceConfigSchema>;
export type RetrievalTraceRetention = z.infer<
  typeof RetrievalTraceRetentionSchema
>;
export type RetrievalTraceRedactionMode = z.infer<
  typeof RetrievalTraceRedactionModeSchema
>;
