/**
 * Runtime validation for project-profile apply receipts crossing command
 * composition boundaries.
 *
 * @module src/core/project-profile-apply-validation
 */

import { z } from "zod";

import type { ProjectProfileApplyReceipt } from "./project-profile-apply";

const diagnosticSchema = z
  .object({
    code: z.literal("STALE_PROFILE_MAPPING"),
    severity: z.literal("warning"),
    path: z.string(),
    message: z.string().min(1),
    remediation: z.string().min(1),
  })
  .strict();

const diffSchema = z
  .object({
    status: z.enum(["in_sync", "changes_required"]),
    changes: z.array(
      z
        .object({
          action: z.enum(["add", "update", "repair", "review"]),
          field: z.string().min(1),
          destructive: z.literal(false),
          summary: z.string().min(1),
        })
        .strict()
    ),
    staleMappings: z.array(
      z
        .object({
          collection: z.string().min(1),
          reason: z.enum(["name_changed", "root_changed"]),
          choices: z.tuple([
            z.literal("repair"),
            z.literal("remove_explicitly"),
          ]),
        })
        .strict()
    ),
  })
  .strict();

const resourceSchema = z
  .object({
    kind: z.enum([
      "capability",
      "collection",
      "content_type",
      "contexts",
      "profile_binding",
      "project_affinity",
      "stale_mapping",
    ]),
    id: z.string().min(1),
    disposition: z.enum(["created", "reused", "updated", "skipped"]),
    pendingIndexing: z.boolean(),
  })
  .strict();

export const projectProfileApplyReceiptSchema: z.ZodType<ProjectProfileApplyReceipt> =
  z
    .object({
      schemaVersion: z.literal("1.0"),
      command: z.literal("apply"),
      status: z.enum(["applied", "unchanged"]),
      profile: z
        .object({
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
      diff: diffSchema,
      resources: z.array(resourceSchema),
      pendingIndexing: z.array(z.string().min(1)),
      diagnostics: z.array(diagnosticSchema),
    })
    .strict()
    .refine(
      (receipt) =>
        new Set(receipt.pendingIndexing).size ===
        receipt.pendingIndexing.length,
      { path: ["pendingIndexing"], message: "Entries must be unique." }
    );

export function isProjectProfileApplyReceipt(
  value: unknown
): value is ProjectProfileApplyReceipt {
  return projectProfileApplyReceiptSchema.safeParse(value).success;
}
