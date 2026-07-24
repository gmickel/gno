/** HTTP receipt persistence for browser-clipper idempotent writes. */

import type { Database } from "bun:sqlite";

import { completeClipperIdempotency } from "../store/sqlite/clipper-store";

export const completeClipperHttpIdempotency = (
  db: Database,
  input: {
    grantId: string;
    keyHash: string;
    requestDigest: string;
    body: unknown;
    status: number;
  }
): Response => {
  const responseJson = JSON.stringify(input.body);
  const completed = completeClipperIdempotency(db, {
    grantId: input.grantId,
    keyHash: input.keyHash,
    requestDigest: input.requestDigest,
    responseJson,
    statusCode: input.status,
    nowMs: Date.now(),
  });
  if (completed.status === "conflict" || completed.status === "not_found") {
    throw new Error(
      `Browser clip idempotency completion failed: ${completed.status}`
    );
  }
  return new Response(responseJson, {
    status: input.status,
    headers: { "Content-Type": "application/json" },
  });
};
