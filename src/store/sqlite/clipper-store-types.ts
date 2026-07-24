/** Public contracts for browser-clipper SQLite persistence. */

export interface ClipperGrantInput {
  id: string;
  tokenHash: string;
  origin: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface ClipperGrant {
  id: string;
  origin: string;
  scope: "capture";
  createdAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
}

export type CreateClipperGrantResult =
  | { status: "created"; grant: ClipperGrant }
  | { status: "duplicate"; grant: ClipperGrant }
  | { status: "conflict" };

export type AuthorizeClipperGrantResult =
  | { status: "authorized"; grant: ClipperGrant }
  | { status: "unauthorized" }
  | { status: "expired" }
  | { status: "revoked" };

export type RevokeClipperGrantResult =
  | { status: "revoked"; grant: ClipperGrant }
  | { status: "already_revoked"; grant: ClipperGrant }
  | { status: "expired"; grant: ClipperGrant }
  | { status: "not_found" };

export type ClipperCollisionPolicyResult =
  | "created"
  | "opened_existing"
  | "created_with_suffix"
  | "overwritten"
  | "conflict";

export interface ClipperIdempotencyPlan {
  collection: string;
  relPath: string;
  collisionPolicyResult: ClipperCollisionPolicyResult;
  contentHash: string;
  clipIdentity: string;
}

export interface ClaimClipperIdempotencyInput {
  grantId: string;
  keyHash: string;
  requestDigest: string;
  plan: ClipperIdempotencyPlan;
  nowMs: number;
}

export interface CompleteClipperIdempotencyInput {
  grantId: string;
  keyHash: string;
  requestDigest: string;
  responseJson: string;
  statusCode: number;
  nowMs: number;
}

export interface InspectClipperIdempotencyInput {
  grantId: string;
  keyHash: string;
  requestDigest: string;
}

export interface ClipperIdempotencyPending {
  requestDigest: string;
  plan: ClipperIdempotencyPlan;
  createdAtMs: number;
}

export interface ClipperIdempotencyReplay extends ClipperIdempotencyPending {
  statusCode: number;
  responseJson: string;
  completedAtMs: number;
}

export type ClaimClipperIdempotencyResult =
  | { status: "claimed" }
  | { status: "pending"; pending: ClipperIdempotencyPending }
  | { status: "replay"; replay: ClipperIdempotencyReplay }
  | { status: "conflict" }
  | { status: "grant_inactive" };

export type InspectClipperIdempotencyResult =
  | { status: "pending"; pending: ClipperIdempotencyPending }
  | { status: "replay"; replay: ClipperIdempotencyReplay }
  | { status: "conflict" }
  | { status: "not_found" };

export type CompleteClipperIdempotencyResult =
  | { status: "completed"; replay: ClipperIdempotencyReplay }
  | { status: "replay"; replay: ClipperIdempotencyReplay }
  | { status: "conflict" }
  | { status: "not_found" };
