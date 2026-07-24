/** In-memory pairing and preview state for the loopback browser clipper. */

import type { Database } from "bun:sqlite";

import type {
  AuthorizeClipperGrantResult,
  ClipperGrant,
} from "../store/sqlite/clipper-store";

import {
  authorizeClipperGrant,
  createClipperGrant,
  revokeClipperGrant,
} from "../store/sqlite/clipper-store";

const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/u;
const PAIR_TTL_MS = 5 * 60 * 1000;
const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_PAIRS = 128;
const MAX_PREVIEWS = 512;
const MAX_APPROVAL_ATTEMPTS = 5;

interface PendingPair {
  approvalAttempts: number;
  codeHash: string;
  expiresAtMs: number;
  origin: string;
  state: "pending" | "approved" | "consumed";
  grant?: {
    id: string;
    token: string;
    expiresAtMs: number;
  };
}

interface IssuedPreview {
  expiresAtMs: number;
  payloadDigest: string;
}

export interface ClipperPairingOptions {
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  pairTtlMs?: number;
  grantTtlMs?: number;
  previewTtlMs?: number;
}

export type ClipperPairPollResult =
  | { status: "pending"; expiresAt: string }
  | {
      status: "approved";
      grantId: string;
      grantToken: string;
      expiresAt: string;
    }
  | { status: "consumed" }
  | { status: "expired" }
  | { status: "not_found" }
  | { status: "origin_mismatch" };

const sha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const randomHex = (
  length: number,
  randomBytes: (length: number) => Uint8Array
): string =>
  [...randomBytes(length)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const defaultRandomBytes = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const pairCode = (randomBytes: (length: number) => Uint8Array): string => {
  const bytes = randomBytes(4);
  const value =
    (((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0)) >>>
    0;
  return String(value % 100_000_000).padStart(8, "0");
};

export const isClipperExtensionOrigin = (origin: string): boolean =>
  EXTENSION_ORIGIN_PATTERN.test(origin);

export class ClipperPairingService {
  readonly #db: Database;
  readonly #now: () => number;
  readonly #randomBytes: (length: number) => Uint8Array;
  readonly #pairTtlMs: number;
  readonly #grantTtlMs: number;
  readonly #previewTtlMs: number;
  readonly #pairs = new Map<string, PendingPair>();
  readonly #previews = new Map<string, IssuedPreview>();
  readonly #csrfToken: string;

  constructor(db: Database, options: ClipperPairingOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.#pairTtlMs = options.pairTtlMs ?? PAIR_TTL_MS;
    this.#grantTtlMs = options.grantTtlMs ?? GRANT_TTL_MS;
    this.#previewTtlMs = options.previewTtlMs ?? PREVIEW_TTL_MS;
    this.#csrfToken = randomHex(32, this.#randomBytes);
  }

  get csrfToken(): string {
    return this.#csrfToken;
  }

  start(origin: string): {
    pairId: string;
    pairingCode: string;
    expiresAt: string;
  } {
    if (!isClipperExtensionOrigin(origin)) {
      throw new TypeError("Invalid browser extension origin");
    }
    this.#prune();
    if (this.#pairs.size >= MAX_PENDING_PAIRS) {
      throw new Error("Too many pending browser clipper pairings");
    }
    const pairId = randomHex(32, this.#randomBytes);
    const code = pairCode(this.#randomBytes);
    const expiresAtMs = this.#now() + this.#pairTtlMs;
    this.#pairs.set(pairId, {
      approvalAttempts: 0,
      codeHash: sha256(`${pairId}\0${origin}\0${code}`),
      expiresAtMs,
      origin,
      state: "pending",
    });
    return {
      pairId,
      pairingCode: code,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  approve(
    pairId: string,
    pairingCode: string
  ):
    | { status: "approved"; origin: string; expiresAt: string }
    | { status: "not_found" | "expired" | "invalid_code" | "already_used" } {
    const pair = this.#pairs.get(pairId);
    if (!pair) return { status: "not_found" };
    const nowMs = this.#now();
    if (nowMs >= pair.expiresAtMs) {
      this.#pairs.delete(pairId);
      return { status: "expired" };
    }
    if (pair.state !== "pending") return { status: "already_used" };
    pair.approvalAttempts += 1;
    const candidate = sha256(`${pairId}\0${pair.origin}\0${pairingCode}`);
    if (!constantTimeEqual(candidate, pair.codeHash)) {
      if (pair.approvalAttempts >= MAX_APPROVAL_ATTEMPTS) {
        this.#pairs.delete(pairId);
      }
      return { status: "invalid_code" };
    }

    const grantId = crypto.randomUUID();
    const token = randomHex(32, this.#randomBytes);
    const expiresAtMs = nowMs + this.#grantTtlMs;
    const created = createClipperGrant(this.#db, {
      id: grantId,
      tokenHash: sha256(token),
      origin: pair.origin,
      createdAtMs: nowMs,
      expiresAtMs,
    });
    if (created.status !== "created") {
      throw new Error("Failed to create browser clipper grant");
    }
    pair.state = "approved";
    pair.grant = { id: grantId, token, expiresAtMs };
    return {
      status: "approved",
      origin: pair.origin,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  poll(pairId: string, origin: string): ClipperPairPollResult {
    const pair = this.#pairs.get(pairId);
    if (!pair) return { status: "not_found" };
    if (pair.origin !== origin) return { status: "origin_mismatch" };
    const nowMs = this.#now();
    if (nowMs >= pair.expiresAtMs) {
      this.#pairs.delete(pairId);
      return { status: "expired" };
    }
    if (pair.state === "pending") {
      return {
        status: "pending",
        expiresAt: new Date(pair.expiresAtMs).toISOString(),
      };
    }
    if (pair.state === "consumed" || !pair.grant) {
      return { status: "consumed" };
    }
    const grant = pair.grant;
    pair.state = "consumed";
    pair.grant = undefined;
    return {
      status: "approved",
      grantId: grant.id,
      grantToken: grant.token,
      expiresAt: new Date(grant.expiresAtMs).toISOString(),
    };
  }

  authorize(token: string, origin: string): AuthorizeClipperGrantResult {
    return authorizeClipperGrant(this.#db, sha256(token), origin, this.#now());
  }

  revoke(
    grant: ClipperGrant
  ):
    | { status: "revoked"; revokedAt: string }
    | { status: "already_revoked" | "expired" | "not_found" } {
    const result = revokeClipperGrant(this.#db, grant.id, this.#now());
    if (result.status !== "revoked") return { status: result.status };
    return {
      status: "revoked",
      revokedAt: new Date(
        result.grant.revokedAtMs ?? this.#now()
      ).toISOString(),
    };
  }

  issuePreview(
    grantId: string,
    previewDigest: string,
    payloadDigest: string
  ): void {
    this.#prune();
    if (this.#previews.size >= MAX_PREVIEWS) {
      const oldest = this.#previews.keys().next().value;
      if (oldest !== undefined) this.#previews.delete(oldest);
    }
    this.#previews.set(`${grantId}:${previewDigest}`, {
      expiresAtMs: this.#now() + this.#previewTtlMs,
      payloadDigest,
    });
  }

  consumePreview(
    grantId: string,
    previewDigest: string,
    payloadDigest: string
  ): "matched" | "missing" | "expired" | "mismatch" {
    const key = `${grantId}:${previewDigest}`;
    const preview = this.#previews.get(key);
    if (!preview) return "missing";
    this.#previews.delete(key);
    if (this.#now() >= preview.expiresAtMs) return "expired";
    return preview.payloadDigest === payloadDigest ? "matched" : "mismatch";
  }

  verifyPreview(
    grantId: string,
    previewDigest: string,
    payloadDigest: string
  ): "matched" | "missing" | "expired" | "mismatch" {
    const preview = this.#previews.get(`${grantId}:${previewDigest}`);
    if (!preview) return "missing";
    if (this.#now() >= preview.expiresAtMs) return "expired";
    return preview.payloadDigest === payloadDigest ? "matched" : "mismatch";
  }

  #prune(): void {
    const nowMs = this.#now();
    for (const [id, pair] of this.#pairs) {
      if (nowMs < pair.expiresAtMs) continue;
      this.#pairs.delete(id);
    }
    for (const [key, preview] of this.#previews) {
      if (nowMs >= preview.expiresAtMs) this.#previews.delete(key);
    }
  }
}
