import { describe, expect, test } from "bun:test";

import {
  captureReceiptSchema,
  clipperErrorSchema,
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

  test("accepts server-owned preview and versioned receipts without deriving them", () => {
    const preview = previewSchema.parse(previewResponse);
    const receipt = captureReceiptSchema.parse(receiptResponse);
    expect(preview.preview.digest).toBe("4".repeat(64));
    expect(preview.preview.body).toContain("Exact café selection");
    expect(receipt.contentHash).toBe("2".repeat(64));
    expect(
      previewSchema.safeParse({ ...previewResponse, localHash: "bad" }).success
    ).toBeFalse();
    expect(
      captureReceiptSchema.safeParse({
        ...receiptResponse,
        schemaVersion: "9.0",
      }).success
    ).toBeFalse();
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
});
