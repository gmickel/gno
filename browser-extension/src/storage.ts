import type { ClipperLocalState, PendingCapture, StoredGrant } from "./types";

const STATE_KEY = "gnoClipperLocalState";
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1(?::\d{1,5})?$/u;
const HEX_64 = /^[a-f0-9]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VISIBLE_ASCII = /^[\x21-\x7e]{1,256}$/u;

export interface LocalStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const emptyState = (): ClipperLocalState => ({
  gatewayOrigin: null,
  grant: null,
  pending: null,
});

const isGrant = (value: unknown): value is StoredGrant => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const grant = value as Record<string, unknown>;
  return (
    Object.keys(grant).length === 3 &&
    typeof grant.grantId === "string" &&
    UUID.test(grant.grantId) &&
    typeof grant.grantToken === "string" &&
    HEX_64.test(grant.grantToken) &&
    typeof grant.expiresAt === "string" &&
    Number.isFinite(Date.parse(grant.expiresAt))
  );
};

const isPending = (value: unknown): value is PendingCapture => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const pending = value as Record<string, unknown>;
  return (
    Object.keys(pending).length === 3 &&
    typeof pending.payload === "object" &&
    pending.payload !== null &&
    typeof pending.previewDigest === "string" &&
    HEX_64.test(pending.previewDigest) &&
    typeof pending.idempotencyKey === "string" &&
    VISIBLE_ASCII.test(pending.idempotencyKey)
  );
};

export const readClipperState = async (
  storage: LocalStorageArea = chrome.storage.local
): Promise<ClipperLocalState> => {
  const stored = (await storage.get(STATE_KEY))[STATE_KEY];
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return emptyState();
  }
  const candidate = stored as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !== "gatewayOrigin,grant,pending" ||
    (candidate.gatewayOrigin !== null &&
      (typeof candidate.gatewayOrigin !== "string" ||
        !LOOPBACK_ORIGIN.test(candidate.gatewayOrigin))) ||
    (candidate.grant !== null && !isGrant(candidate.grant)) ||
    (candidate.pending !== null && !isPending(candidate.pending))
  ) {
    return emptyState();
  }
  return candidate as unknown as ClipperLocalState;
};

export const writeClipperState = async (
  state: ClipperLocalState,
  storage: LocalStorageArea = chrome.storage.local
): Promise<void> => {
  if (
    (state.gatewayOrigin !== null &&
      !LOOPBACK_ORIGIN.test(state.gatewayOrigin)) ||
    (state.grant !== null && !isGrant(state.grant)) ||
    (state.pending !== null && !isPending(state.pending))
  ) {
    throw new Error("Refusing to persist invalid browser clipper state");
  }
  await storage.set({ [STATE_KEY]: state });
};

export const clearGrant = async (
  storage: LocalStorageArea = chrome.storage.local
): Promise<void> => {
  const state = await readClipperState(storage);
  await writeClipperState({ ...state, grant: null, pending: null }, storage);
};

export const isGrantExpired = (
  grant: StoredGrant,
  nowMs = Date.now()
): boolean => Date.parse(grant.expiresAt) <= nowMs;

export { STATE_KEY as CLIPPER_STORAGE_KEY };
