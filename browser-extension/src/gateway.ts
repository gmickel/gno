import type {
  BrowserClipPayload,
  BrowserClipPreview,
  CaptureReceipt,
  PairStart,
  PairStatus,
  PendingCapture,
  StoredGrant,
} from "./types";

import {
  captureReceiptSchema,
  clipperErrorSchema,
  pairStartSchema,
  pairStatusSchema,
  parseContract,
  previewSchema,
  revokeSchema,
} from "./contracts";

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1(?::\d{1,5})?$/u;
const ERROR_STATUS = {
  CLIPPER_ABORTED: 503,
  CLIPPER_BODY_TOO_LARGE: 413,
  CLIPPER_BUSY: 429,
  CLIPPER_FORBIDDEN: 403,
  CLIPPER_INVALID_JSON: 400,
  CLIPPER_RATE_LIMITED: 429,
  CLIPPER_UNAUTHORIZED: 401,
  CLIPPER_PAIRING_UNAVAILABLE: 429,
  CLIPPER_CSRF: 403,
  CLIPPER_INVALID_REQUEST: 400,
  CLIPPER_PAIR_NOT_FOUND: 404,
  CLIPPER_PAIR_EXPIRED: 410,
  CLIPPER_PAIR_INVALID_CODE: 403,
  CLIPPER_PAIR_ALREADY_USED: 410,
  CLIPPER_PREVIEW_MISMATCH: 409,
  CLIPPER_PREVIEW_REQUIRED: 409,
  CLIPPER_IDEMPOTENCY_PENDING: 409,
  CLIPPER_IDEMPOTENCY_CONFLICT: 409,
  CLIPPER_IDEMPOTENCY_RECOVERY_CONFLICT: 409,
  CLIPPER_IDEMPOTENCY_GRANT_INACTIVE: 409,
  CLIPPER_CAPTURE_FAILED: 500,
  NOT_FOUND: 404,
  RUNTIME: 500,
  VALIDATION: 409,
} as const;

export class ClipperGatewayError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly refreshPreview: boolean;
  readonly clearGrant: boolean;

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      refreshPreview?: boolean;
      clearGrant?: boolean;
    } = {}
  ) {
    super(message);
    this.name = "ClipperGatewayError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.refreshPreview = options.refreshPreview ?? false;
    this.clearGrant = options.clearGrant ?? false;
  }
}

const errorOptions = (
  code: string
): {
  retryable?: boolean;
  refreshPreview?: boolean;
  clearGrant?: boolean;
} => {
  if (code === "CLIPPER_UNAUTHORIZED") return { clearGrant: true };
  if (
    code === "CLIPPER_PREVIEW_REQUIRED" ||
    code === "CLIPPER_PREVIEW_MISMATCH"
  ) {
    return { refreshPreview: true };
  }
  if (
    code === "CLIPPER_IDEMPOTENCY_PENDING" ||
    code === "CLIPPER_BUSY" ||
    code === "CLIPPER_RATE_LIMITED" ||
    code === "RUNTIME"
  ) {
    return { retryable: true };
  }
  return {};
};

const parseJson = async (response: Response): Promise<unknown> => {
  if (
    !(response.headers.get("content-type") ?? "").includes("application/json")
  ) {
    throw new ClipperGatewayError(
      "CLIPPER_INVALID_RESPONSE",
      "The local gateway returned a non-JSON response."
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ClipperGatewayError(
      "CLIPPER_INVALID_RESPONSE",
      "The local gateway returned malformed JSON."
    );
  }
};

export class ClipperGateway {
  readonly origin: string;
  readonly fetcher: typeof fetch;

  constructor(origin: string, fetcher: typeof fetch = fetch) {
    if (!LOOPBACK_ORIGIN.test(origin)) {
      throw new Error("GNO gateway must be an exact 127.0.0.1 HTTP origin");
    }
    const parsed = new URL(origin);
    if (
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/"
    ) {
      throw new Error("GNO gateway origin contains unsupported URL fields");
    }
    this.origin = origin;
    this.fetcher = fetcher;
  }

  private async request(
    path: string,
    init: RequestInit = {}
  ): Promise<{ response: Response; body: unknown }> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}${path}`, {
        cache: "no-store",
        credentials: "omit",
        ...init,
      });
    } catch {
      throw new ClipperGatewayError(
        "CLIPPER_OFFLINE",
        "Start gno serve, then retry without changing the capture.",
        { retryable: true }
      );
    }
    return { response, body: await parseJson(response) };
  }

  private invalidResponse(): never {
    throw new ClipperGatewayError(
      "CLIPPER_INVALID_RESPONSE",
      "The local gateway returned an unknown response."
    );
  }

  private throwError(response: Response, body: unknown): never {
    const result = clipperErrorSchema.safeParse(body);
    if (!result.success) this.invalidResponse();
    if (ERROR_STATUS[result.data.error.code] !== response.status) {
      this.invalidResponse();
    }
    throw new ClipperGatewayError(
      result.data.error.code,
      result.data.error.message,
      errorOptions(result.data.error.code)
    );
  }

  async startPair(): Promise<PairStart> {
    const { response, body } = await this.request("/api/clipper/pair/start", {
      method: "POST",
    });
    if (response.status !== 200) this.throwError(response, body);
    return parseContract(pairStartSchema, body, "pair start");
  }

  async pollPair(pairId: string): Promise<PairStatus> {
    const { response, body } = await this.request(
      `/api/clipper/pair/${pairId}`,
      {
        method: "GET",
      }
    );
    const result = pairStatusSchema.safeParse(body);
    if (!result.success) this.throwError(response, body);
    const expectedStatus =
      result.data.status === "pending" || result.data.status === "approved"
        ? 200
        : result.data.status === "not_found"
          ? 404
          : 410;
    if (response.status !== expectedStatus) this.invalidResponse();
    return result.data;
  }

  async preview(
    payload: BrowserClipPayload,
    grant: StoredGrant
  ): Promise<BrowserClipPreview> {
    const { response, body } = await this.request("/api/capture/clip/preview", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${grant.grantToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (response.status !== 200) this.throwError(response, body);
    return parseContract(previewSchema, body, "browser clip preview");
  }

  async capture(
    pending: PendingCapture,
    grant: StoredGrant
  ): Promise<{ receipt: CaptureReceipt; replayed: boolean }> {
    const { response, body } = await this.request("/api/capture/clip", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${grant.grantToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": pending.idempotencyKey,
      },
      body: JSON.stringify({
        payload: pending.payload,
        previewDigest: pending.previewDigest,
      }),
    });
    const receipt = captureReceiptSchema.safeParse(body);
    if (receipt.success) {
      const expectedStatus =
        receipt.data.collisionPolicyResult === "opened_existing"
          ? 200
          : receipt.data.collisionPolicyResult === "conflict"
            ? 409
            : 202;
      if (response.status !== expectedStatus) this.invalidResponse();
      return {
        receipt: receipt.data,
        replayed: response.headers.get("Idempotent-Replay") === "true",
      };
    }
    this.throwError(response, body);
  }

  async revoke(grant: StoredGrant): Promise<void> {
    const { response, body } = await this.request("/api/clipper/revoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${grant.grantToken}` },
    });
    if (response.status !== 200) this.throwError(response, body);
    parseContract(revokeSchema, body, "grant revocation");
  }
}
