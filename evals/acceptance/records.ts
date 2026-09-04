/** Full ordered evidence and actual port inputs. No rounding, sorting, newline
 * normalization, prompt reconstruction, or omission of citation provenance. */
import { z } from "zod";

import { canonicalFingerprint } from "../agentic/canonical";
import { ACCEPTANCE_SCHEMA_VERSION, sha256Schema } from "./manifest";

const spanSchema = z
  .strictObject({
    uri: z.string().min(1),
    sourceHash: sha256Schema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    text: z.string(),
    provenance: z.record(z.string(), z.json()),
  })
  .refine((span) => span.endLine >= span.startLine, "Invalid span coordinates");

export const deterministicRecordSchema = z.strictObject({
  scope: z.record(z.string(), z.json()),
  results: z.array(
    z.strictObject({
      uri: z.string().min(1),
      score: z.number().finite(),
      scores: z.record(z.string(), z.number().finite()),
      passage: spanSchema.nullable(),
      provenance: z.record(z.string(), z.json()),
    })
  ),
  citations: z.array(spanSchema),
  modelInputs: z.array(
    z.strictObject({
      role: z.enum(["embedding", "reranking", "generation"]),
      modelId: z.string().min(1),
      // Exact arguments delivered to the model port, including options and order.
      input: z.json(),
    })
  ),
  semanticState: z.strictObject({
    status: z.enum(["ok", "error", "incomplete"]),
    vectorsUsed: z.boolean(),
    // Captured independently at the vector stage, not inferred from vectorsUsed.
    vectorStatus: z.enum(["used", "not-requested", "unavailable", "error"]),
    error: z.json().nullable(),
    fallbacks: z.array(z.json()),
    verification: z.json().nullable(),
  }),
});

export const acceptanceRecordSchema = z.strictObject({
  schemaVersion: z.literal(ACCEPTANCE_SCHEMA_VERSION),
  manifestSha256: sha256Schema,
  caseId: z.string().min(1),
  deterministic: deterministicRecordSchema,
  // Only generated prose is stochastic. Citations/verification remain above.
  generatedAnswer: z.string().nullable(),
  // Only these explicitly enumerated fields are excluded from exact equality.
  transport: z.strictObject({
    requestId: z.string().optional(),
    capturedAt: z.string().optional(),
    durationMs: z.number().finite().nonnegative().optional(),
  }),
});

export type AcceptanceRecord = z.infer<typeof acceptanceRecordSchema>;
export type DeterministicRecord = z.infer<typeof deterministicRecordSchema>;

export function deterministicRecordFingerprint(
  value: DeterministicRecord
): string {
  return canonicalFingerprint(deterministicRecordSchema.parse(value));
}
