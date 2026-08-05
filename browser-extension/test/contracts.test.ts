import { describe, expect, test } from "bun:test";

import {
  captureReceiptSchema,
  clipperErrorSchema,
  egressLineageSchema,
  pairStartSchema,
  pairStatusSchema,
  previewSchema,
  revokeSchema,
} from "../src/contracts";
import { grant, previewResponse, receiptResponse } from "./fixtures";

describe("closed browser clipper response contracts", () => {
  test("accepts every pairing state and rejects unknown versions or fields", () => {
    const start = {
      schemaVersion: "1.0",
      pairId: "b".repeat(64),
      pairingCode: "12345678",
      expiresAt: "2026-07-24T08:05:00.000Z",
      origin: `chrome-extension://${"a".repeat(32)}`,
      approvalPath: "/api/clipper/pair/approve",
    };
    expect(pairStartSchema.safeParse(start).success).toBeTrue();
    for (const status of [
      {
        schemaVersion: "1.0",
        status: "pending",
        expiresAt: start.expiresAt,
      },
      { schemaVersion: "1.0", status: "approved", ...grant },
      { schemaVersion: "1.0", status: "consumed" },
      { schemaVersion: "1.0", status: "expired" },
      { schemaVersion: "1.0", status: "not_found" },
      { schemaVersion: "1.0", status: "origin_mismatch" },
    ]) {
      expect(pairStatusSchema.safeParse(status).success).toBeTrue();
    }
    expect(
      pairStartSchema.safeParse({ ...start, schemaVersion: "2.0" }).success
    ).toBeFalse();
    expect(
      pairStartSchema.safeParse({ ...start, grantToken: "x" }).success
    ).toBeFalse();
  });

  test("accepts server-owned preview and versioned receipts without deriving them", async () => {
    const preview = await previewSchema.parseAsync(previewResponse);
    const receipt = captureReceiptSchema.parse(receiptResponse);
    expect(preview.preview.digest).toBe("4".repeat(64));
    expect(preview.preview.body).toContain("Exact café selection");
    expect(preview.preview.egressLineage).toEqual(
      previewResponse.preview.egressLineage
    );
    expect(receipt.contentHash).toBe("2".repeat(64));
    expect(
      (
        await previewSchema.safeParseAsync({
          ...previewResponse,
          localHash: "bad",
        })
      ).success
    ).toBeFalse();
    expect(
      captureReceiptSchema.safeParse({
        ...receiptResponse,
        schemaVersion: "9.0",
      }).success
    ).toBeFalse();
  });

  test("keeps browser preview egress lineage closed and structurally valid", async () => {
    expect(
      (
        await egressLineageSchema.safeParseAsync(
          previewResponse.preview.egressLineage
        )
      ).success
    ).toBeTrue();
    expect(
      (
        await egressLineageSchema.safeParseAsync({
          ...previewResponse.preview.egressLineage,
          effectivePolicy: "internet",
        })
      ).success
    ).toBeFalse();
    expect(
      (
        await egressLineageSchema.safeParseAsync({
          ...previewResponse.preview.egressLineage,
          unexpected: "field",
        })
      ).success
    ).toBeFalse();
    expect(
      (
        await egressLineageSchema.safeParseAsync({
          ...previewResponse.preview.egressLineage,
          sources: [
            previewResponse.preview.egressLineage.sources[0],
            previewResponse.preview.egressLineage.sources[0],
          ],
        })
      ).success
    ).toBeFalse();
  });

  test("rejects forged, non-canonical, or unbounded preview lineage", async () => {
    const canonicalSources = [
      { collection: "alpha", policy: "remote", source: "explicit" },
      {
        collection: "notes",
        policy: "local_only",
        source: "legacy_default",
      },
    ] as const;
    const canonical = {
      effectivePolicy: "local_only",
      digest:
        "6b7497a4a251cf5caf493b75db6d7c2cacdef427d99b1bb2a3139dd227ff130d",
      sources: canonicalSources,
    };
    expect((await egressLineageSchema.safeParseAsync(canonical)).success).toBe(
      true
    );

    for (const forged of [
      { ...canonical, digest: "0".repeat(64) },
      {
        ...canonical,
        sources: [...canonical.sources].reverse(),
      },
      {
        ...canonical,
        sources: [
          canonical.sources[0],
          {
            collection: "alpha",
            policy: "local_only",
            source: "explicit",
          },
        ],
      },
      {
        ...canonical,
        effectivePolicy: "remote",
        sources: [
          {
            collection: "notes",
            policy: "remote",
            source: "legacy_default",
          },
        ],
      },
      {
        ...canonical,
        sources: Array.from({ length: 129 }, (_, index) => ({
          collection: `c${index}`,
          policy: "remote",
          source: "explicit",
        })),
      },
    ]) {
      expect((await egressLineageSchema.safeParseAsync(forged)).success).toBe(
        false
      );
    }
  });

  test("distinguishes revoke and every known closed error from unknown codes", () => {
    expect(
      revokeSchema.safeParse({
        schemaVersion: "1.0",
        grantId: grant.grantId,
        status: "revoked",
        revokedAt: "2026-07-24T08:02:00.000Z",
      }).success
    ).toBeTrue();
    expect(
      revokeSchema.safeParse({
        schemaVersion: "1.0",
        grantId: grant.grantId,
        status: "expired",
        revokedAt: "2026-07-24T08:02:00.000Z",
      }).success
    ).toBeFalse();
    expect(
      clipperErrorSchema.safeParse({
        error: {
          code: "CLIPPER_IDEMPOTENCY_RECOVERY_CONFLICT",
          message: "Stop and inspect the existing destination.",
        },
      }).success
    ).toBeTrue();
    expect(
      clipperErrorSchema.safeParse({
        error: { code: "SOMETHING_NEW", message: "not accepted" },
      }).success
    ).toBeFalse();
  });

  test("permits error details only beside the code that produces them", () => {
    const details = {
      reason: "PATH_OUTSIDE_COLLECTION",
      relPath: "clips/article.md",
    };
    expect(
      clipperErrorSchema.safeParse({
        error: {
          code: "VALIDATION",
          message: "Refused a destination outside the collection.",
          details,
        },
      }).success
    ).toBeTrue();
    // Only the capture route's destination refusal carries details, and it
    // reports VALIDATION; every other code paired with details is a response
    // no server emits.
    for (const code of [
      "CLIPPER_UNAUTHORIZED",
      "CLIPPER_CAPTURE_FAILED",
      "RUNTIME",
    ]) {
      expect(
        clipperErrorSchema.safeParse({
          error: { code, message: "not accepted", details },
        }).success
      ).toBeFalse();
    }
    expect(
      clipperErrorSchema.safeParse({
        error: {
          code: "VALIDATION",
          message: "not accepted",
          details: { reason: "NOT_A_REASON", relPath: "clips/article.md" },
        },
      }).success
    ).toBeFalse();
  });
});
