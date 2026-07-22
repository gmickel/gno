import { z } from "zod";

import {
  CONTEXT_CAPSULE_COORDINATE_SPACE,
  CONTEXT_CAPSULE_SCHEMA_VERSION,
  contextCapsuleGnoUriSchema,
  contextCapsuleIndexSnapshotSchema,
} from "./context-capsule-schema";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nullableSha256Schema = sha256Schema.nullable();
const positiveIntegerSchema = z.number().int().positive();

export const contextCapsuleVerificationEvidenceSchema = z
  .object({
    evidenceId: sha256Schema,
    uri: contextCapsuleGnoUriSchema,
    contentStatus: z.enum(["unchanged", "stale", "missing"]),
    contentCode: z.enum([
      "verified_unchanged",
      "source_stale",
      "mirror_stale",
      "passage_stale",
      "source_missing",
    ]),
    rankingStatus: z.enum(["unchanged", "reranked", "unavailable"]),
    rankingCode: z.enum([
      "ranking_unchanged",
      "ranking_changed",
      "ranking_unavailable",
    ]),
    currentSourceHash: nullableSha256Schema,
    currentMirrorHash: nullableSha256Schema,
    currentPassageHash: nullableSha256Schema,
    currentRetrievalRank: positiveIntegerSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const hashes = [
      value.currentSourceHash,
      value.currentMirrorHash,
      value.currentPassageHash,
    ];
    const contentValid =
      (value.contentStatus === "unchanged" &&
        value.contentCode === "verified_unchanged" &&
        hashes.every((hash) => hash !== null)) ||
      (value.contentStatus === "stale" &&
        ["source_stale", "mirror_stale", "passage_stale"].includes(
          value.contentCode
        ) &&
        hashes.every((hash) => hash !== null)) ||
      (value.contentStatus === "missing" &&
        value.contentCode === "source_missing" &&
        hashes.every((hash) => hash === null));
    const rankingValid =
      (value.rankingStatus === "unchanged" &&
        value.rankingCode === "ranking_unchanged" &&
        value.currentRetrievalRank !== null) ||
      (value.rankingStatus === "reranked" &&
        value.rankingCode === "ranking_changed" &&
        value.currentRetrievalRank !== null) ||
      (value.rankingStatus === "unavailable" &&
        value.rankingCode === "ranking_unavailable" &&
        value.currentRetrievalRank === null);
    if (!contentValid) {
      context.addIssue({
        code: "custom",
        message: "impossible content result",
      });
    }
    if (
      !rankingValid ||
      (value.contentStatus !== "unchanged" &&
        value.rankingStatus !== "unavailable")
    ) {
      context.addIssue({
        code: "custom",
        message: "impossible ranking result",
      });
    }
  });

export const contextCapsuleVerificationSchema = z
  .object({
    schemaVersion: z.literal(CONTEXT_CAPSULE_SCHEMA_VERSION),
    coordinateSpace: z.literal(CONTEXT_CAPSULE_COORDINATE_SPACE),
    capsuleId: sha256Schema,
    operationStatus: z.literal("completed"),
    contentStatus: z.enum(["unchanged", "stale", "missing"]),
    contentCode: z.enum([
      "verified_unchanged",
      "content_stale",
      "content_missing",
    ]),
    rankingStatus: z.enum(["unchanged", "reranked", "unavailable"]),
    rankingCode: z.enum([
      "ranking_unchanged",
      "ranking_changed",
      "ranking_unavailable",
    ]),
    indexSnapshot: contextCapsuleIndexSnapshotSchema,
    evidence: z.array(contextCapsuleVerificationEvidenceSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.evidence.map((item) => item.evidenceId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "duplicate evidence verification",
        path: ["evidence"],
      });
    }
    const content = value.evidence.some(
      (item) => item.contentStatus === "missing"
    )
      ? "missing"
      : value.evidence.some((item) => item.contentStatus === "stale")
        ? "stale"
        : "unchanged";
    const ranking = value.evidence.some(
      (item) => item.rankingStatus === "unavailable"
    )
      ? "unavailable"
      : value.evidence.some((item) => item.rankingStatus === "reranked")
        ? "reranked"
        : "unchanged";
    const contentCode = {
      unchanged: "verified_unchanged",
      stale: "content_stale",
      missing: "content_missing",
    }[content];
    const rankingCode = {
      unchanged: "ranking_unchanged",
      reranked: "ranking_changed",
      unavailable: "ranking_unavailable",
    }[ranking];
    if (value.contentStatus !== content || value.contentCode !== contentCode) {
      context.addIssue({
        code: "custom",
        message: "aggregate content status disagrees with evidence",
      });
    }
    if (value.rankingStatus !== ranking || value.rankingCode !== rankingCode) {
      context.addIssue({
        code: "custom",
        message: "aggregate ranking status disagrees with evidence",
      });
    }
  });

export type ContextCapsuleVerification = z.infer<
  typeof contextCapsuleVerificationSchema
>;
