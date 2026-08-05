import { z } from "zod";

import type {
  BrowserClipPreview,
  CaptureReceipt,
  PairStart,
  PairStatus,
} from "./types";

const hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//iu.test(value));
const extensionOrigin = z.string().regex(/^chrome-extension:\/\/[a-p]{32}$/u);
const collectionName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);

const egressPolicy = z.enum(["local_only", "lan", "remote"]);
const egressPolicySource = z.enum([
  "explicit",
  "config_default",
  "legacy_default",
]);
const MAX_EGRESS_LINEAGE_SOURCES = 128;
const POLICY_RESTRICTIVENESS = {
  local_only: 0,
  lan: 1,
  remote: 2,
} as const;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sha256Text = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const egressLineageSchema = z
  .object({
    effectivePolicy: egressPolicy,
    digest: hex64,
    sources: z
      .array(
        z
          .object({
            collection: collectionName,
            policy: egressPolicy,
            source: egressPolicySource,
          })
          .strict()
      )
      .min(1)
      .max(MAX_EGRESS_LINEAGE_SOURCES),
  })
  .strict()
  .superRefine(async (value, context) => {
    const collections = value.sources.map(({ collection }) => collection);
    if (new Set(collections).size !== collections.length) {
      context.addIssue({
        code: "custom",
        message: "Egress lineage collections must be unique",
        path: ["sources"],
      });
      return;
    }
    if (
      value.sources.some(
        ({ policy, source }) => source !== "explicit" && policy !== "local_only"
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Default egress lineage sources must remain local-only",
        path: ["sources"],
      });
      return;
    }
    const canonicalSources = [...value.sources].sort((left, right) =>
      compareCodeUnits(left.collection, right.collection)
    );
    if (JSON.stringify(canonicalSources) !== JSON.stringify(value.sources)) {
      context.addIssue({
        code: "custom",
        message: "Egress lineage sources must be canonically ordered",
        path: ["sources"],
      });
      return;
    }
    const effectivePolicy = canonicalSources.reduce<
      keyof typeof POLICY_RESTRICTIVENESS
    >(
      (mostRestrictive, source) =>
        POLICY_RESTRICTIVENESS[source.policy] <
        POLICY_RESTRICTIVENESS[mostRestrictive]
          ? source.policy
          : mostRestrictive,
      "remote"
    );
    const digest = await sha256Text(
      JSON.stringify({
        effectivePolicy,
        sources: canonicalSources.map(({ collection, policy, source }) => ({
          collection,
          policy,
          source,
        })),
      })
    );
    if (value.effectivePolicy !== effectivePolicy || value.digest !== digest) {
      context.addIssue({
        code: "custom",
        message: "Egress lineage must be canonical and digest-bound",
      });
    }
  });

const destination = z
  .object({
    collection: z.string().min(1),
    relPath: z.string().nullable(),
    folderPath: z.string().nullable(),
    collisionPolicy: z.enum(["error", "open_existing", "create_with_suffix"]),
  })
  .strict();

const warningCode = z.enum([
  "authenticated_visible_content",
  "canonical_url_differs",
  "edited_content",
  "line_endings_normalized",
  "reader_partial",
  "selection_truncated",
  "spa_snapshot",
  "unicode_normalized",
]);

const browser = z
  .object({
    name: z.string(),
    version: z.string().nullable(),
    platform: z.string().nullable(),
  })
  .strict();

const provenance = z
  .object({
    schemaVersion: z.literal("1.0"),
    mode: z.enum(["selection", "reader"]),
    sourceUrl: httpUrl,
    canonicalUrl: httpUrl.nullable(),
    title: z.string(),
    author: z.string().nullable(),
    site: z.string().nullable(),
    publishedAt: z.string().nullable(),
    observedAt: dateTime,
    capturedAt: dateTime,
    extractionHash: hex64,
    finalBodyHash: hex64,
    clipIdentity: hex64,
    previewDigest: hex64,
    exactSelection: z.string().nullable(),
    extractionWarnings: z.array(warningCode),
    browser,
  })
  .strict();

const source = z
  .object({
    kind: z.literal("web"),
    title: z.string(),
    url: httpUrl,
    uri: z.string().optional(),
    docid: z.string().optional(),
    mime: z.string().optional(),
    ext: z.string().optional(),
    author: z.string().optional(),
    canonicalUrl: httpUrl.optional(),
    site: z.string().optional(),
    publishedAt: z.string().optional(),
    observedAt: dateTime,
    capturedAt: dateTime,
    externalId: z.string().optional(),
    browserClip: provenance,
  })
  .strict();

const indexStatus = z
  .object({
    status: z.enum([
      "not_requested",
      "pending",
      "running",
      "completed",
      "skipped",
      "failed",
      "unknown",
    ]),
    jobId: z.string().nullable().optional(),
    reason: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

export const pairStartSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    pairId: hex64,
    pairingCode: z.string().regex(/^\d{8}$/u),
    expiresAt: dateTime,
    origin: extensionOrigin,
    approvalPath: z.literal("/api/clipper/pair/approve"),
  })
  .strict()
  .transform(({ schemaVersion: _, ...value }) => value satisfies PairStart);

export const pairStatusSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        schemaVersion: z.literal("1.0"),
        status: z.literal("pending"),
        expiresAt: dateTime,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal("1.0"),
        status: z.literal("approved"),
        grantId: uuid,
        grantToken: hex64,
        expiresAt: dateTime,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal("1.0"),
        status: z.enum(["consumed", "expired", "not_found", "origin_mismatch"]),
      })
      .strict(),
  ])
  .transform(({ schemaVersion: _, ...value }) => value satisfies PairStatus);

export const revokeSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    grantId: uuid,
    status: z.enum(["revoked", "already_revoked", "expired", "not_found"]),
    revokedAt: dateTime.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "revoked") !== (value.revokedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "revokedAt must match revoked status",
      });
    }
  });

export const previewSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    preview: z
      .object({
        body: z.string(),
        digest: hex64,
        source,
        destination,
        egressLineage: egressLineageSchema.optional(),
        tags: z.array(z.string()),
      })
      .strict(),
    provenance,
    plan: z
      .object({
        collection: z.string().min(1),
        relPath: z.string().min(1),
        outcome: z.enum([
          "created",
          "opened_existing",
          "created_with_suffix",
          "overwritten",
          "conflict",
        ]),
        provenanceConflict: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .transform(
    ({ schemaVersion: _, ...value }) => value satisfies BrowserClipPreview
  );

export const captureReceiptSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    uri: z.string().regex(/^gno:\/\/[^/]+\/.+/u),
    docid: z.string().optional(),
    collection: z.string(),
    relPath: z.string(),
    absPath: z.string().optional(),
    created: z.boolean(),
    openedExisting: z.boolean(),
    createdWithSuffix: z.boolean(),
    overwritten: z.boolean().optional(),
    contentHash: hex64,
    source,
    tags: z.array(z.string()),
    sync: indexStatus,
    embed: indexStatus,
    collisionPolicyResult: z.enum([
      "created",
      "opened_existing",
      "created_with_suffix",
      "overwritten",
      "conflict",
    ]),
    serverInstanceId: z.string().optional(),
  })
  .strict()
  .transform(
    ({ schemaVersion: _, ...value }) => value satisfies CaptureReceipt
  );

export const ERROR_CODES = [
  "CLIPPER_ABORTED",
  "CLIPPER_BODY_TOO_LARGE",
  "CLIPPER_BUSY",
  "CLIPPER_FORBIDDEN",
  "CLIPPER_INVALID_JSON",
  "CLIPPER_RATE_LIMITED",
  "CLIPPER_UNAUTHORIZED",
  "CLIPPER_PAIRING_UNAVAILABLE",
  "CLIPPER_CSRF",
  "CLIPPER_INVALID_REQUEST",
  "CLIPPER_PAIR_NOT_FOUND",
  "CLIPPER_PAIR_EXPIRED",
  "CLIPPER_PAIR_INVALID_CODE",
  "CLIPPER_PAIR_ALREADY_USED",
  "CLIPPER_PREVIEW_MISMATCH",
  "CLIPPER_PREVIEW_REQUIRED",
  "CLIPPER_IDEMPOTENCY_PENDING",
  "CLIPPER_IDEMPOTENCY_CONFLICT",
  "CLIPPER_IDEMPOTENCY_RECOVERY_CONFLICT",
  "CLIPPER_IDEMPOTENCY_GRANT_INACTIVE",
  "CLIPPER_CAPTURE_FAILED",
  "NOT_FOUND",
  "RUNTIME",
  "VALIDATION",
] as const;

/**
 * Why a write destination was refused, carried structurally.
 *
 * A `VALIDATION` refusal from the capture route distinguishes an alias that
 * escapes the collection from one the indexer will simply never follow. The
 * codes are the server's `CaptureDestinationError` codes; the object stays
 * closed and optional, so every other error keeps its exact two-key shape.
 */
export const CAPTURE_DESTINATION_REASONS = [
  "PATH_OUTSIDE_COLLECTION",
  "PATH_NOT_WALKABLE",
  "PATH_UNRESOLVED",
  "NOT_DIRECTORY",
] as const;

/**
 * The ONE error code that carries `details`.
 *
 * `details` is produced by exactly one server path - the capture route's
 * destination refusal, reported as `VALIDATION`/409. Making `details` optional
 * on its own would accept, say, a `CLIPPER_UNAUTHORIZED` carrying a `relPath`,
 * which no server emits; pairing the two keeps the contract as closed on the
 * client as it is on the wire.
 */
export const DETAILS_ERROR_CODE = "VALIDATION" as const;

export const captureDestinationDetailsSchema = z
  .object({
    reason: z.enum(CAPTURE_DESTINATION_REASONS),
    relPath: z.string().min(1),
  })
  .strict();

export type CaptureDestinationDetails = z.infer<
  typeof captureDestinationDetailsSchema
>;

export const clipperErrorSchema = z
  .object({
    error: z
      .object({
        code: z.enum(ERROR_CODES),
        message: z.string().min(1),
        details: captureDestinationDetailsSchema.optional(),
      })
      .strict()
      .refine(
        (error) =>
          error.details === undefined || error.code === DETAILS_ERROR_CODE,
        {
          message: `Only ${DETAILS_ERROR_CODE} errors carry details`,
          path: ["details"],
        }
      ),
  })
  .strict();

export const parseContract = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  name: string
): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid or unsupported ${name} response`);
  }
  return result.data;
};

export const parseContractAsync = async <T>(
  schema: z.ZodType<T>,
  value: unknown,
  name: string
): Promise<T> => {
  const result = await schema.safeParseAsync(value);
  if (!result.success) {
    throw new Error(`Invalid or unsupported ${name} response`);
  }
  return result.data;
};
