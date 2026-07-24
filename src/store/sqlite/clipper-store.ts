/** SQLite persistence primitives for the loopback browser clipper. */

import type { Database } from "bun:sqlite";

import type {
  AuthorizeClipperGrantResult,
  ClaimClipperIdempotencyInput,
  ClaimClipperIdempotencyResult,
  ClipperCollisionPolicyResult,
  ClipperGrant,
  ClipperGrantInput,
  ClipperIdempotencyPending,
  ClipperIdempotencyPlan,
  ClipperIdempotencyReplay,
  CompleteClipperIdempotencyInput,
  CompleteClipperIdempotencyResult,
  CreateClipperGrantResult,
  InspectClipperIdempotencyInput,
  InspectClipperIdempotencyResult,
  RevokeClipperGrantResult,
} from "./clipper-store-types";

export type {
  AuthorizeClipperGrantResult,
  ClaimClipperIdempotencyInput,
  ClaimClipperIdempotencyResult,
  ClipperCollisionPolicyResult,
  ClipperGrant,
  ClipperGrantInput,
  ClipperIdempotencyPending,
  ClipperIdempotencyPlan,
  ClipperIdempotencyReplay,
  CompleteClipperIdempotencyInput,
  CompleteClipperIdempotencyResult,
  CreateClipperGrantResult,
  InspectClipperIdempotencyInput,
  InspectClipperIdempotencyResult,
  RevokeClipperGrantResult,
} from "./clipper-store-types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/u;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface DbClipperGrantRow {
  id: string;
  token_hash: string;
  origin: string;
  scope: "capture";
  created_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
}

interface DbClipperIdempotencyRow {
  key_hash: string;
  request_digest: string;
  collection: string;
  rel_path: string;
  collision_policy_result: ClipperCollisionPolicyResult;
  content_hash: string;
  clip_identity: string;
  state: "pending" | "completed";
  status_code: number | null;
  response_json: string | null;
  created_at_ms: number;
  completed_at_ms: number | null;
}

const assertIdentifier = (value: string, label: string): void => {
  if (value.length < 1 || value.length > MAX_IDENTIFIER_LENGTH) {
    throw new RangeError(
      `${label} must contain between 1 and ${MAX_IDENTIFIER_LENGTH} characters`
    );
  }
};

const assertSha256 = (value: string, label: string): void => {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
};

const assertTimestamp = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
};

const mapGrant = (row: DbClipperGrantRow): ClipperGrant => ({
  id: row.id,
  origin: row.origin,
  scope: row.scope,
  createdAtMs: row.created_at_ms,
  expiresAtMs: row.expires_at_ms,
  revokedAtMs: row.revoked_at_ms,
});

const getGrantByIdentity = (
  db: Database,
  id: string,
  tokenHash: string
): DbClipperGrantRow | null =>
  db
    .query<DbClipperGrantRow, [string, string]>(
      `SELECT id, token_hash, origin, scope, created_at_ms, expires_at_ms,
              revoked_at_ms
       FROM clipper_grants
       WHERE id = ? OR token_hash = ?
       LIMIT 1`
    )
    .get(id, tokenHash) ?? null;

const getGrantById = (db: Database, id: string): DbClipperGrantRow | null =>
  db
    .query<DbClipperGrantRow, [string]>(
      `SELECT id, token_hash, origin, scope, created_at_ms, expires_at_ms,
              revoked_at_ms
       FROM clipper_grants
       WHERE id = ?`
    )
    .get(id) ?? null;

const getIdempotencyRow = (
  db: Database,
  grantId: string,
  keyHash: string
): DbClipperIdempotencyRow | null =>
  db
    .query<DbClipperIdempotencyRow, [string, string]>(
      `SELECT key_hash, request_digest, collection, rel_path,
              collision_policy_result, content_hash, clip_identity, state,
              status_code, response_json, created_at_ms, completed_at_ms
       FROM clipper_capture_idempotency
       WHERE grant_id = ? AND key_hash = ?`
    )
    .get(grantId, keyHash) ?? null;

const getIdempotencyRowByDigest = (
  db: Database,
  grantId: string,
  requestDigest: string
): DbClipperIdempotencyRow | null =>
  db
    .query<DbClipperIdempotencyRow, [string, string]>(
      `SELECT key_hash, request_digest, collection, rel_path,
              collision_policy_result, content_hash, clip_identity, state,
              status_code, response_json, created_at_ms, completed_at_ms
       FROM clipper_capture_idempotency
       WHERE grant_id = ? AND request_digest = ?`
    )
    .get(grantId, requestDigest) ?? null;

const planFromRow = (row: DbClipperIdempotencyRow): ClipperIdempotencyPlan => ({
  collection: row.collection,
  relPath: row.rel_path,
  collisionPolicyResult: row.collision_policy_result,
  contentHash: row.content_hash,
  clipIdentity: row.clip_identity,
});

const pendingFromRow = (
  row: DbClipperIdempotencyRow
): ClipperIdempotencyPending => ({
  requestDigest: row.request_digest,
  plan: planFromRow(row),
  createdAtMs: row.created_at_ms,
});

const replayFromRow = (
  row: DbClipperIdempotencyRow
): ClipperIdempotencyReplay | null => {
  if (
    row.state !== "completed" ||
    row.status_code === null ||
    row.response_json === null ||
    row.completed_at_ms === null
  ) {
    return null;
  }
  return {
    ...pendingFromRow(row),
    statusCode: row.status_code,
    responseJson: row.response_json,
    completedAtMs: row.completed_at_ms,
  };
};

const idempotencyResultFromRow = (
  row: DbClipperIdempotencyRow
):
  | { status: "pending"; pending: ClipperIdempotencyPending }
  | { status: "replay"; replay: ClipperIdempotencyReplay } => {
  const replay = replayFromRow(row);
  return replay
    ? { status: "replay", replay }
    : { status: "pending", pending: pendingFromRow(row) };
};

const assertPlan = (plan: ClipperIdempotencyPlan): void => {
  if (
    plan.collection.length < 1 ||
    new TextEncoder().encode(plan.collection).byteLength > 256
  ) {
    throw new RangeError("Clipper plan collection is empty or too long");
  }
  if (
    plan.relPath.length < 1 ||
    new TextEncoder().encode(plan.relPath).byteLength > 8192
  ) {
    throw new RangeError("Clipper plan relative path is empty or too long");
  }
  if (
    ![
      "created",
      "opened_existing",
      "created_with_suffix",
      "overwritten",
      "conflict",
    ].includes(plan.collisionPolicyResult)
  ) {
    throw new TypeError("Clipper plan has an invalid collision result");
  }
  assertSha256(plan.contentHash, "Clipper plan content hash");
  assertSha256(plan.clipIdentity, "Clipper plan identity");
};

const plansMatch = (
  left: ClipperIdempotencyPlan,
  right: ClipperIdempotencyPlan
): boolean =>
  left.collection === right.collection &&
  left.relPath === right.relPath &&
  left.collisionPolicyResult === right.collisionPolicyResult &&
  left.contentHash === right.contentHash &&
  left.clipIdentity === right.clipIdentity;

export const createClipperGrant = (
  db: Database,
  input: ClipperGrantInput
): CreateClipperGrantResult => {
  assertIdentifier(input.id, "Grant id");
  assertSha256(input.tokenHash, "Grant token hash");
  if (!EXTENSION_ORIGIN_PATTERN.test(input.origin)) {
    throw new TypeError(
      "Grant origin must be an exact chrome-extension origin"
    );
  }
  assertTimestamp(input.createdAtMs, "Grant creation time");
  assertTimestamp(input.expiresAtMs, "Grant expiry");
  if (input.expiresAtMs <= input.createdAtMs) {
    throw new RangeError("Grant expiry must be after its creation time");
  }

  const insert = db.run(
    `INSERT OR IGNORE INTO clipper_grants (
       id, token_hash, origin, scope, created_at_ms, expires_at_ms
     ) VALUES (?, ?, ?, 'capture', ?, ?)`,
    [
      input.id,
      input.tokenHash,
      input.origin,
      input.createdAtMs,
      input.expiresAtMs,
    ]
  );
  const row = getGrantByIdentity(db, input.id, input.tokenHash);
  if (!row) {
    throw new Error("Failed to read persisted clipper grant");
  }
  const grant = mapGrant(row);
  if (insert.changes > 0) return { status: "created", grant };
  if (
    row.id === input.id &&
    row.token_hash === input.tokenHash &&
    row.origin === input.origin &&
    row.created_at_ms === input.createdAtMs &&
    row.expires_at_ms === input.expiresAtMs
  ) {
    return { status: "duplicate", grant };
  }
  return { status: "conflict" };
};

export const authorizeClipperGrant = (
  db: Database,
  tokenHash: string,
  origin: string,
  nowMs: number
): AuthorizeClipperGrantResult => {
  assertSha256(tokenHash, "Grant token hash");
  assertTimestamp(nowMs, "Authorization time");
  if (!EXTENSION_ORIGIN_PATTERN.test(origin)) return { status: "unauthorized" };
  const row = db
    .query<DbClipperGrantRow, [string]>(
      `SELECT id, token_hash, origin, scope, created_at_ms, expires_at_ms,
              revoked_at_ms
       FROM clipper_grants
       WHERE token_hash = ?`
    )
    .get(tokenHash);
  if (!row || row.origin !== origin) return { status: "unauthorized" };
  const grant = mapGrant(row);
  if (nowMs < grant.createdAtMs) return { status: "unauthorized" };
  if (grant.revokedAtMs !== null) return { status: "revoked" };
  if (nowMs >= grant.expiresAtMs) return { status: "expired" };
  return { status: "authorized", grant };
};

export const revokeClipperGrant = (
  db: Database,
  grantId: string,
  nowMs: number
): RevokeClipperGrantResult => {
  assertIdentifier(grantId, "Grant id");
  assertTimestamp(nowMs, "Revocation time");
  const row = db
    .query<DbClipperGrantRow, [string]>(
      `SELECT id, token_hash, origin, scope, created_at_ms, expires_at_ms,
              revoked_at_ms
       FROM clipper_grants
       WHERE id = ?`
    )
    .get(grantId);
  if (!row) return { status: "not_found" };
  const grant = mapGrant(row);
  if (grant.revokedAtMs !== null) {
    return { status: "already_revoked", grant };
  }
  if (nowMs >= grant.expiresAtMs) return { status: "expired", grant };
  const update = db.run(
    `UPDATE clipper_grants
     SET revoked_at_ms = ?
     WHERE id = ? AND revoked_at_ms IS NULL`,
    [Math.max(nowMs, grant.createdAtMs), grantId]
  );
  if (update.changes === 0) {
    const current = getGrantById(db, grantId);
    if (!current) return { status: "not_found" };
    return { status: "already_revoked", grant: mapGrant(current) };
  }
  return {
    status: "revoked",
    grant: { ...grant, revokedAtMs: Math.max(nowMs, grant.createdAtMs) },
  };
};

export const claimClipperIdempotency = (
  db: Database,
  input: ClaimClipperIdempotencyInput
): ClaimClipperIdempotencyResult => {
  assertIdentifier(input.grantId, "Grant id");
  assertSha256(input.keyHash, "Idempotency key hash");
  assertSha256(input.requestDigest, "Request digest");
  assertPlan(input.plan);
  assertTimestamp(input.nowMs, "Claim time");
  const grant = db
    .query<
      {
        created_at_ms: number;
        expires_at_ms: number;
        revoked_at_ms: number | null;
      },
      [string]
    >(
      `SELECT created_at_ms, expires_at_ms, revoked_at_ms
       FROM clipper_grants
       WHERE id = ?`
    )
    .get(input.grantId);
  if (
    !grant ||
    grant.revoked_at_ms !== null ||
    input.nowMs < grant.created_at_ms ||
    input.nowMs >= grant.expires_at_ms
  ) {
    return { status: "grant_inactive" };
  }
  const insert = db.run(
    `INSERT OR IGNORE INTO clipper_capture_idempotency (
       grant_id, key_hash, request_digest, collection, rel_path,
       collision_policy_result, content_hash, clip_identity, state,
       created_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      input.grantId,
      input.keyHash,
      input.requestDigest,
      input.plan.collection,
      input.plan.relPath,
      input.plan.collisionPolicyResult,
      input.plan.contentHash,
      input.plan.clipIdentity,
      input.nowMs,
    ]
  );
  if (insert.changes > 0) return { status: "claimed" };
  const keyRow = getIdempotencyRow(db, input.grantId, input.keyHash);
  if (keyRow && keyRow.request_digest !== input.requestDigest) {
    return { status: "conflict" };
  }
  const row =
    keyRow ?? getIdempotencyRowByDigest(db, input.grantId, input.requestDigest);
  if (!row) throw new Error("Failed to read clipper idempotency claim");
  const storedPlan = planFromRow(row);
  if (!plansMatch(storedPlan, input.plan)) {
    return { status: "conflict" };
  }
  return idempotencyResultFromRow(row);
};

export const inspectClipperIdempotency = (
  db: Database,
  input: InspectClipperIdempotencyInput
): InspectClipperIdempotencyResult => {
  assertIdentifier(input.grantId, "Grant id");
  assertSha256(input.keyHash, "Idempotency key hash");
  assertSha256(input.requestDigest, "Request digest");
  const keyRow = getIdempotencyRow(db, input.grantId, input.keyHash);
  if (keyRow && keyRow.request_digest !== input.requestDigest) {
    return { status: "conflict" };
  }
  const row =
    keyRow ?? getIdempotencyRowByDigest(db, input.grantId, input.requestDigest);
  return row ? idempotencyResultFromRow(row) : { status: "not_found" };
};

export const completeClipperIdempotency = (
  db: Database,
  input: CompleteClipperIdempotencyInput
): CompleteClipperIdempotencyResult => {
  assertIdentifier(input.grantId, "Grant id");
  assertSha256(input.keyHash, "Idempotency key hash");
  assertSha256(input.requestDigest, "Request digest");
  assertTimestamp(input.nowMs, "Completion time");
  if (
    !Number.isInteger(input.statusCode) ||
    input.statusCode < 200 ||
    input.statusCode > 599
  ) {
    throw new RangeError("Response status code must be between 200 and 599");
  }
  if (
    new TextEncoder().encode(input.responseJson).byteLength > MAX_RESPONSE_BYTES
  ) {
    throw new RangeError(
      `Clipper response exceeds ${MAX_RESPONSE_BYTES} UTF-8 bytes`
    );
  }
  try {
    JSON.parse(input.responseJson);
  } catch {
    throw new TypeError("Clipper response must be valid JSON");
  }

  const keyRow = getIdempotencyRow(db, input.grantId, input.keyHash);
  if (keyRow && keyRow.request_digest !== input.requestDigest) {
    return { status: "conflict" };
  }
  const existing =
    keyRow ?? getIdempotencyRowByDigest(db, input.grantId, input.requestDigest);
  if (!existing) return { status: "not_found" };
  const existingReplay = replayFromRow(existing);
  if (existingReplay) {
    return existingReplay.statusCode === input.statusCode &&
      existingReplay.responseJson === input.responseJson
      ? { status: "replay", replay: existingReplay }
      : { status: "conflict" };
  }
  const update = db.run(
    `UPDATE clipper_capture_idempotency
     SET state = 'completed',
         status_code = ?,
         response_json = ?,
         completed_at_ms = ?
     WHERE grant_id = ? AND key_hash = ? AND request_digest = ?
       AND state = 'pending'`,
    [
      input.statusCode,
      input.responseJson,
      input.nowMs,
      input.grantId,
      existing.key_hash,
      input.requestDigest,
    ]
  );
  const completed = getIdempotencyRow(db, input.grantId, existing.key_hash);
  const replay = completed ? replayFromRow(completed) : null;
  if (!replay) throw new Error("Failed to complete clipper idempotency claim");
  if (update.changes > 0) return { status: "completed", replay };
  return replay.statusCode === input.statusCode &&
    replay.responseJson === input.responseJson
    ? { status: "replay", replay }
    : { status: "conflict" };
};
