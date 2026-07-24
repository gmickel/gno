const PAIR_ID = /^[a-f0-9]{64}$/u;
const PAIRING_CODE = /^\d{8}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/u;
const KNOWN_ERROR_CODES = new Set([
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
]);

export interface ClipperPairLaunch {
  pairId: string | null;
  valid: boolean;
}

export interface ClipperApproval {
  origin: string;
  expiresAt: string;
}

export class ClipperApprovalError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "ClipperApprovalError";
    this.code = code;
    this.retryable = retryable;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const isDateTime = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  value.includes("T");

export const consumeClipperPairLaunch = (
  location: Pick<Location, "pathname" | "search" | "hash">,
  history: Pick<History, "replaceState">
): ClipperPairLaunch => {
  if (location.pathname !== "/clipper/pair") {
    return { pairId: null, valid: false };
  }
  const match =
    location.search === ""
      ? /^#pairId=(?<pairId>[a-f0-9]{64})$/u.exec(location.hash)
      : null;
  history.replaceState({}, "", "/clipper/pair");
  const pairId = match?.groups?.pairId ?? null;
  return { pairId, valid: pairId !== null };
};

const parseError = (value: unknown): ClipperApprovalError | null => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["error"]) ||
    !isRecord(value.error) ||
    !hasExactKeys(value.error, ["code", "message"]) ||
    typeof value.error.code !== "string" ||
    !KNOWN_ERROR_CODES.has(value.error.code) ||
    typeof value.error.message !== "string" ||
    value.error.message.length === 0
  ) {
    return null;
  }
  return new ClipperApprovalError(
    value.error.code,
    value.error.message,
    value.error.code === "CLIPPER_PAIR_INVALID_CODE"
  );
};

const readJson = async (response: Response): Promise<unknown> => {
  if (
    !(response.headers.get("content-type") ?? "").includes("application/json")
  ) {
    throw new ClipperApprovalError(
      "CLIPPER_INVALID_RESPONSE",
      "GNO returned a non-JSON pairing response."
    );
  }
  try {
    return await response.json();
  } catch {
    throw new ClipperApprovalError(
      "CLIPPER_INVALID_RESPONSE",
      "GNO returned malformed pairing data."
    );
  }
};

const requireSuccess = (response: Response, value: unknown): void => {
  if (response.ok) return;
  const parsed = parseError(value);
  if (parsed) throw parsed;
  throw new ClipperApprovalError(
    "CLIPPER_INVALID_RESPONSE",
    "GNO returned an unknown pairing error."
  );
};

export async function approveClipperPair(
  pairId: string,
  pairingCode: string,
  fetcher: typeof fetch = fetch
): Promise<ClipperApproval> {
  if (!PAIR_ID.test(pairId) || !PAIRING_CODE.test(pairingCode)) {
    throw new ClipperApprovalError(
      "CLIPPER_INVALID_REQUEST",
      "Enter the exact eight-digit code shown by the extension."
    );
  }

  const csrfResponse = await fetcher("/api/clipper/pair/csrf", {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
  });
  const csrfBody = await readJson(csrfResponse);
  requireSuccess(csrfResponse, csrfBody);
  if (
    !isRecord(csrfBody) ||
    !hasExactKeys(csrfBody, ["schemaVersion", "csrfToken"]) ||
    csrfBody.schemaVersion !== "1.0" ||
    typeof csrfBody.csrfToken !== "string" ||
    !TOKEN.test(csrfBody.csrfToken)
  ) {
    throw new ClipperApprovalError(
      "CLIPPER_INVALID_RESPONSE",
      "GNO returned an unsupported pairing response."
    );
  }

  const approvalResponse = await fetcher("/api/clipper/pair/approve", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-GNO-CSRF": csrfBody.csrfToken,
    },
    body: JSON.stringify({ pairId, pairingCode }),
  });
  const approvalBody = await readJson(approvalResponse);
  requireSuccess(approvalResponse, approvalBody);
  if (
    !isRecord(approvalBody) ||
    !hasExactKeys(approvalBody, [
      "schemaVersion",
      "status",
      "origin",
      "expiresAt",
    ]) ||
    approvalBody.schemaVersion !== "1.0" ||
    approvalBody.status !== "approved" ||
    typeof approvalBody.origin !== "string" ||
    !EXTENSION_ORIGIN.test(approvalBody.origin) ||
    !isDateTime(approvalBody.expiresAt)
  ) {
    throw new ClipperApprovalError(
      "CLIPPER_INVALID_RESPONSE",
      "GNO returned an unsupported pairing response."
    );
  }
  return {
    origin: approvalBody.origin,
    expiresAt: approvalBody.expiresAt,
  };
}
