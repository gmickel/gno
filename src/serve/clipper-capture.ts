/** Browser-clipper write orchestration and crash-safe idempotency recovery. */

import type { Database } from "bun:sqlite";

import type { PreparedBrowserClip } from "../core/browser-clip";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { ClipperIdempotencyReplay } from "../store/sqlite/clipper-store-types";
import type { ResidentCaptureContext } from "./capture-service";
import type { ClipperPairingService } from "./clipper-pairing";

import { prepareBrowserClip } from "../core/browser-clip";
import {
  claimClipperIdempotency,
  inspectClipperIdempotency,
} from "../store/sqlite/clipper-store";
import {
  browserClipIdempotencyPlan,
  executeResidentCapturePlan,
  planResidentCapture,
  recoverPendingResidentBrowserClip,
} from "./capture-service";
import {
  clipperCaptureWriteSchema,
  clipperErrorResponse,
  clipperSha256,
  isClipperIdempotencyKey,
} from "./clipper-contract";
import { completeClipperHttpIdempotency } from "./clipper-idempotency";

interface ExecuteClipperCaptureInput {
  request: Request;
  body: unknown;
  grantId: string;
  db: Database;
  context: ResidentCaptureContext;
  store: SqliteAdapter;
  pairing: ClipperPairingService;
}

const inFlightRequests = new Set<string>();

const inFlightKey = (grantId: string, requestDigest: string): string =>
  `${grantId}\0${requestDigest}`;

const pendingResponse = (): Response =>
  clipperErrorResponse(
    "CLIPPER_IDEMPOTENCY_PENDING",
    "The matching browser capture is still in progress",
    409
  );

const replayResponse = (replay: ClipperIdempotencyReplay): Response =>
  new Response(replay.responseJson, {
    status: replay.statusCode,
    headers: {
      "Content-Type": "application/json",
      "Idempotent-Replay": "true",
    },
  });

const completeResponse = (
  input: ExecuteClipperCaptureInput,
  keyHash: string,
  requestDigest: string,
  body: unknown,
  status: number
): Response =>
  completeClipperHttpIdempotency(input.db, {
    grantId: input.grantId,
    keyHash,
    requestDigest,
    body:
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? { schemaVersion: "1.0", ...body }
        : body,
    status,
  });

const executeAndComplete = async (
  input: ExecuteClipperCaptureInput,
  keyHash: string,
  requestDigest: string,
  planned: Parameters<typeof executeResidentCapturePlan>[2]
): Promise<Response> => {
  const result = await executeResidentCapturePlan(
    input.context,
    input.store,
    planned
  );
  return completeResponse(
    input,
    keyHash,
    requestDigest,
    result.body,
    result.status
  );
};

const recoverPending = async (
  input: ExecuteClipperCaptureInput,
  prepared: PreparedBrowserClip,
  keyHash: string,
  requestDigest: string,
  plan: Parameters<typeof recoverPendingResidentBrowserClip>[3]
): Promise<Response> => {
  const activeKey = inFlightKey(input.grantId, requestDigest);
  if (inFlightRequests.has(activeKey)) return pendingResponse();
  inFlightRequests.add(activeKey);
  try {
    const recovered = await recoverPendingResidentBrowserClip(
      input.context,
      input.store,
      prepared,
      plan
    );
    if (recovered.status === "conflict") {
      return clipperErrorResponse(
        "CLIPPER_IDEMPOTENCY_RECOVERY_CONFLICT",
        recovered.message,
        409
      );
    }
    if (recovered.status === "execute") {
      return executeAndComplete(
        input,
        keyHash,
        requestDigest,
        recovered.planned
      );
    }
    return completeResponse(
      input,
      keyHash,
      requestDigest,
      recovered.body,
      recovered.statusCode
    );
  } finally {
    inFlightRequests.delete(activeKey);
  }
};

export const executeClipperCapture = async (
  input: ExecuteClipperCaptureInput
): Promise<Response> => {
  const parsed = clipperCaptureWriteSchema.safeParse(input.body);
  const idempotencyKey = input.request.headers.get("idempotency-key") ?? "";
  if (!parsed.success || !isClipperIdempotencyKey(idempotencyKey)) {
    return clipperErrorResponse(
      "CLIPPER_INVALID_REQUEST",
      "A valid preview and Idempotency-Key are required",
      400
    );
  }

  const prepared = prepareBrowserClip(parsed.data.payload);
  if (prepared.preview.digest !== parsed.data.previewDigest) {
    return clipperErrorResponse(
      "CLIPPER_PREVIEW_MISMATCH",
      "Browser clip changed after preview",
      409
    );
  }

  const payloadDigest = clipperSha256(JSON.stringify(prepared.payload));
  const requestDigest = clipperSha256(
    `${parsed.data.previewDigest}\0${payloadDigest}`
  );
  const keyHash = clipperSha256(idempotencyKey);
  const inspected = inspectClipperIdempotency(input.db, {
    grantId: input.grantId,
    keyHash,
    requestDigest,
  });
  if (inspected.status === "replay") {
    return replayResponse(inspected.replay);
  }
  if (inspected.status === "conflict") {
    return clipperErrorResponse(
      "CLIPPER_IDEMPOTENCY_CONFLICT",
      "Idempotency key was used for a different browser capture",
      409
    );
  }
  if (inspected.status === "pending") {
    return recoverPending(
      input,
      prepared,
      keyHash,
      requestDigest,
      inspected.pending.plan
    );
  }

  if (
    input.pairing.verifyPreview(
      input.grantId,
      parsed.data.previewDigest,
      payloadDigest
    ) !== "matched"
  ) {
    return clipperErrorResponse(
      "CLIPPER_PREVIEW_REQUIRED",
      "Create a fresh matching preview before capture",
      409
    );
  }

  const planned = await planResidentCapture(
    input.context,
    input.store,
    prepared.captureInput
  );
  if (!planned.ok) {
    return clipperErrorResponse(planned.code, planned.message, planned.status);
  }
  const claim = claimClipperIdempotency(input.db, {
    grantId: input.grantId,
    keyHash,
    requestDigest,
    plan: browserClipIdempotencyPlan(planned),
    nowMs: Date.now(),
  });
  if (claim.status === "replay") return replayResponse(claim.replay);
  if (claim.status === "pending") {
    return recoverPending(
      input,
      prepared,
      keyHash,
      requestDigest,
      claim.pending.plan
    );
  }
  if (claim.status !== "claimed") {
    return clipperErrorResponse(
      `CLIPPER_IDEMPOTENCY_${claim.status.toUpperCase()}`,
      "Idempotency key cannot be claimed",
      409
    );
  }
  const activeKey = inFlightKey(input.grantId, requestDigest);
  inFlightRequests.add(activeKey);
  try {
    return await executeAndComplete(input, keyHash, requestDigest, planned);
  } finally {
    inFlightRequests.delete(activeKey);
  }
};
