/**
 * Durable request receipts for opted-in mutation retries.
 *
 * One private SQLite ledger per index identity (next to the index database,
 * never inside it) records each caller-supplied request ID within its trusted
 * namespace. Admission, recovery and completion run under the existing shared
 * write lease, so the lease plus the unique (namespace, request ID) key is the
 * whole concurrency story: there is no second lock hierarchy.
 *
 * @module src/core/request-receipts
 */

import { Database } from "bun:sqlite";
// node:fs/promises chmod/mkdir/lstat/readdir: filesystem structure ops, no Bun equivalent
import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { basename, dirname, join } from "node:path";

import { MCP_ERRORS } from "./errors";
import { withWriteLock } from "./file-lock";
import {
  isOwnerOnlyDescriptor,
  windowsDirectoryDescriptor,
  windowsPrivatePath,
} from "./windows-private-path";
import { writeLeasePath } from "./write-lease";

/** Committed receipts keep their full outcome this long, then become tombstones. */
export const REQUEST_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard cap on ledger rows (full receipts plus tombstones). */
export const REQUEST_LEDGER_MAX_ROWS = 100_000;
export const REQUEST_ID_MAX_LENGTH = 128;
/** Namespace of the single local owner (CLI, SDK, stdio MCP, REST). */
export const LOCAL_OWNER_NAMESPACE = "local";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
/** Ledger directory beside the index databases; survives `gno reset`. */
export const REQUEST_LEDGER_DIR = "write-receipts";
const LEDGER_BUSY_TIMEOUT_MS = 5_000;

export type RequestOperation = "capture" | "remember" | "document.update";

export type RequestReceiptErrorCode =
  | "REQUEST_ID_INVALID"
  | "REQUEST_ID_CONFLICT"
  | "REQUEST_PENDING"
  | "REQUEST_RECOVERY_CONFLICT"
  | "REQUEST_EXPIRED"
  | "REQUEST_CAPACITY_EXHAUSTED"
  | "REQUEST_LEDGER_UNAVAILABLE";

export const REQUEST_RECEIPT_HTTP_STATUS: Readonly<
  Record<RequestReceiptErrorCode, number>
> = {
  REQUEST_ID_INVALID: 400,
  REQUEST_ID_CONFLICT: 409,
  REQUEST_PENDING: 409,
  REQUEST_RECOVERY_CONFLICT: 409,
  REQUEST_EXPIRED: 410,
  REQUEST_CAPACITY_EXHAUSTED: 507,
  REQUEST_LEDGER_UNAVAILABLE: 503,
};

export class RequestReceiptError extends Error {
  readonly code: RequestReceiptErrorCode;

  constructor(code: RequestReceiptErrorCode, message: string) {
    super(message);
    this.name = "RequestReceiptError";
    this.code = code;
  }
}

/** Non-content pointer to what a committed request produced. */
export interface RequestResultRef {
  uri?: string;
  docid?: string;
  contentHash?: string;
  sourceHash?: string;
}

/** Attached to a write result when the caller supplied a request ID. */
export interface RequestReceiptInfo {
  requestId: string;
  status: "committed";
  replayed: boolean;
  committedAt: string;
}

export interface RequestStatusResult {
  requestId: string;
  status: "pending" | "committed" | "expired" | "not_found";
  operation?: RequestOperation;
  createdAt?: string;
  updatedAt?: string;
  result?: RequestResultRef;
}

/** Where a request ledger lives for one index database. */
export function requestLedgerPath(dbPath: string): string {
  return join(dirname(dbPath), REQUEST_LEDGER_DIR, basename(dbPath));
}

/**
 * Ledger, lease and namespace for the local owner of one index database:
 * the ledger and the write lease derive from the same path.
 */
export function localRequestLedger(dbPath: string): {
  ledgerPath: string;
  lockPath: string;
  namespace: string;
} {
  return {
    ledgerPath: requestLedgerPath(dbPath),
    lockPath: writeLeasePath(dbPath),
    namespace: LOCAL_OWNER_NAMESPACE,
  };
}

/** One text line for a write result carrying a request receipt. */
export function formatRequestReceiptLine(request: RequestReceiptInfo): string {
  return `Request: ${request.requestId} committed${request.replayed ? " (replayed, nothing written again)" : ""}`;
}

const REQUEST_STATUS_NEXT_STEP: Record<RequestStatusResult["status"], string> =
  {
    committed: "Committed: do not resend; the retained outcome replays.",
    pending:
      "Pending: retry the same write with the same request ID to finish it.",
    expired:
      "Expired: this ID already ran and will not run again; check current state before using a new ID.",
    not_found: "Not found: nothing was accepted under this ID.",
  };

/** Human-readable request status (CLI and MCP text output). */
export function formatRequestStatus(result: RequestStatusResult): string {
  const lines = [`Request: ${result.requestId}`, `Status: ${result.status}`];
  if (result.operation) lines.push(`Operation: ${result.operation}`);
  if (result.updatedAt) lines.push(`Updated: ${result.updatedAt}`);
  if (result.result?.uri) lines.push(`URI: ${result.result.uri}`);
  lines.push(REQUEST_STATUS_NEXT_STEP[result.status]);
  return lines.join("\n");
}

/** Validate an opaque caller request ID before anything is admitted. */
export function validateRequestId(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > REQUEST_ID_MAX_LENGTH ||
    !REQUEST_ID_PATTERN.test(raw)
  ) {
    throw new RequestReceiptError(
      "REQUEST_ID_INVALID",
      `requestId must be 1-${REQUEST_ID_MAX_LENGTH} characters of letters, digits, '.', '_', ':' or '-', starting with a letter or digit.`
    );
  }
  return raw;
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** HTTP MCP namespace: the authorized identity (loopback or bearer digest). */
export function httpMcpRequestNamespace(securityIdentity: string): string {
  return `mcp-http:${sha256(securityIdentity).slice(0, 32)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

/** Digest of the semantic operation; transport identity must not be included. */
export function requestDigest(
  operation: RequestOperation,
  payload: unknown
): string {
  return sha256(`${operation}\u0000${canonicalJson(payload)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger
// ─────────────────────────────────────────────────────────────────────────────

interface LedgerRow {
  operation: RequestOperation;
  digest: string;
  status: "pending" | "committed" | "expired";
  created_at_ms: number;
  updated_at_ms: number;
  plan_json: string | null;
  published: number;
  result_json: string | null;
  ref_json: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS request_receipts (
  namespace TEXT NOT NULL,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'expired')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  plan_json TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  ref_json TEXT,
  PRIMARY KEY (namespace, request_id)
) WITHOUT ROWID`;

/** Ledger directories whose owner-only Windows DACL this process verified. */
const privateLedgerDirs = new Set<string>();

/** Inside the ledger directory: what the last authoritative check verified. */
const LEDGER_DIR_MARKER = ".owner-only-verified";

export interface PrivateDirAcl {
  /** Authoritative check (spawns PowerShell); `create` sets the owner-only DACL first. */
  verify: (dir: string, create: boolean) => Promise<void>;
  /** In-process owner and DACL bytes, or null when they cannot be read. */
  descriptor: (dir: string) => Uint8Array | null;
}

const WINDOWS_ACL: PrivateDirAcl = {
  verify: windowsPrivatePath,
  descriptor: windowsDirectoryDescriptor,
};

/** Directory identity plus descriptor digest; null unless owner-only. */
async function ledgerDirStamp(
  dir: string,
  acl: PrivateDirAcl
): Promise<string | null> {
  const { dev, ino } = await lstat(dir, { bigint: true });
  const descriptor = acl.descriptor(dir);
  if (!descriptor || !isOwnerOnlyDescriptor(descriptor)) return null;
  const digest = new Bun.CryptoHasher("sha256")
    .update(descriptor)
    .digest("hex");
  return `${dev}:${ino}:${digest}`;
}

/**
 * Windows ignores POSIX modes: give a new ledger directory the current-user
 * DACL before SQLite creates the database or its WAL/SHM (they inherit it),
 * and refuse an existing one that grants another principal access.
 *
 * The PowerShell check costs a process start, so its success is recorded in a
 * marker inside the directory. A later open skips it only when the directory
 * is the same object and its owner and DACL are byte-identical to the verified
 * ones and still owner-only; reading the marker at all requires access that
 * owner-only DACL grants. Anything else re-runs the authoritative check.
 *
 * An existing but empty directory is secured like a new one: a first open
 * interrupted before its DACL was set leaves exactly that, and nothing inside
 * it could have been exposed.
 */
export async function securePrivateLedgerDir(
  dir: string,
  created: boolean,
  acl: PrivateDirAcl = WINDOWS_ACL
): Promise<void> {
  const marker = Bun.file(join(dir, LEDGER_DIR_MARKER));
  if (!created) {
    const stamp = await ledgerDirStamp(dir, acl);
    if (stamp !== null && stamp === (await marker.text().catch(() => null)))
      return;
  }
  const secure = created || (await readdir(dir)).length === 0;
  await acl.verify(dir, secure);
  const stamp = await ledgerDirStamp(dir, acl);
  if (stamp !== null) await Bun.write(marker, stamp);
}

async function openLedger(path: string): Promise<Database> {
  try {
    const dir = dirname(path);
    const created = await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32" && !privateLedgerDirs.has(dir)) {
      await securePrivateLedgerDir(dir, created !== undefined);
      privateLedgerDirs.add(dir);
    }
    const db = new Database(path, { create: true, strict: true });
    try {
      // POSIX: private before any journal file exists (they inherit this mode).
      await chmod(path, 0o600);
      db.run(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
      db.run("PRAGMA journal_mode = WAL");
      db.run(SCHEMA);
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  } catch (error) {
    throw new RequestReceiptError(
      "REQUEST_LEDGER_UNAVAILABLE",
      `Request ledger is unavailable; nothing was written: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** A committed receipt past retention reads as expired even before compaction. */
function getRow(
  db: Database,
  namespace: string,
  requestId: string,
  nowMs: number
): LedgerRow | null {
  const row = readRow(db, namespace, requestId);
  if (
    row?.status !== "committed" ||
    row.updated_at_ms >= nowMs - REQUEST_RECEIPT_RETENTION_MS
  ) {
    return row;
  }
  return { ...row, status: "expired", result_json: null, ref_json: null };
}

function readRow(
  db: Database,
  namespace: string,
  requestId: string
): LedgerRow | null {
  return db
    .query<LedgerRow, [string, string]>(
      `SELECT operation, digest, status, created_at_ms, updated_at_ms,
              plan_json, published, result_json, ref_json
         FROM request_receipts WHERE namespace = ? AND request_id = ?`
    )
    .get(namespace, requestId);
}

/** Compact expired receipts, enforce the cap, then admit one row. */
function admitRow(
  db: Database,
  input: {
    namespace: string;
    requestId: string;
    operation: RequestOperation;
    digest: string;
    nowMs: number;
    status: "pending" | "committed";
    planJson: string | null;
    resultJson: string | null;
    refJson: string | null;
  }
): void {
  // Committed on its own: a capacity rejection must not undo compaction.
  db.query(
    `UPDATE request_receipts
        SET status = 'expired', plan_json = NULL, result_json = NULL, ref_json = NULL
      WHERE status = 'committed' AND updated_at_ms < ?`
  ).run(input.nowMs - REQUEST_RECEIPT_RETENTION_MS);
  db.transaction(() => {
    const count =
      db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM request_receipts")
        .get()?.n ?? 0;
    if (count >= REQUEST_LEDGER_MAX_ROWS) {
      throw new RequestReceiptError(
        "REQUEST_CAPACITY_EXHAUSTED",
        `Request ledger is full (${REQUEST_LEDGER_MAX_ROWS} receipts); nothing was written. Retry without a request ID or see the troubleshooting guide.`
      );
    }
    db.query(
      `INSERT INTO request_receipts
         (namespace, request_id, operation, digest, status, created_at_ms,
          updated_at_ms, plan_json, result_json, ref_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.namespace,
      input.requestId,
      input.operation,
      input.digest,
      input.status,
      input.nowMs,
      input.nowMs,
      input.planJson,
      input.resultJson,
      input.refJson
    );
  }).immediate();
}

function updatePlan(
  db: Database,
  namespace: string,
  requestId: string,
  planJson: string,
  nowMs: number
): void {
  db.query(
    `UPDATE request_receipts SET plan_json = ?, published = 0, updated_at_ms = ?
      WHERE namespace = ? AND request_id = ? AND status = 'pending'`
  ).run(planJson, nowMs, namespace, requestId);
}

function setPublished(
  db: Database,
  namespace: string,
  requestId: string
): void {
  db.query(
    `UPDATE request_receipts SET published = 1
      WHERE namespace = ? AND request_id = ?`
  ).run(namespace, requestId);
}

function deleteRow(db: Database, namespace: string, requestId: string): void {
  db.query(
    `DELETE FROM request_receipts
      WHERE namespace = ? AND request_id = ? AND status = 'pending'`
  ).run(namespace, requestId);
}

function commitRow(
  db: Database,
  namespace: string,
  requestId: string,
  resultJson: string,
  refJson: string,
  nowMs: number
): void {
  db.query(
    `UPDATE request_receipts
        SET status = 'committed', plan_json = NULL, result_json = ?,
            ref_json = ?, updated_at_ms = ?
      WHERE namespace = ? AND request_id = ? AND status = 'pending'`
  ).run(resultJson, refJson, nowMs, namespace, requestId);
}

/** Receipt lookup inside one namespace. Never reveals stored outcomes. */
export async function readRequestStatus(input: {
  ledgerPath: string;
  namespace: string;
  requestId: unknown;
}): Promise<RequestStatusResult> {
  const requestId = validateRequestId(input.requestId);
  if (!(await Bun.file(input.ledgerPath).exists())) {
    return { requestId, status: "not_found" };
  }
  const db = await openLedger(input.ledgerPath);
  try {
    const row = getRow(db, input.namespace, requestId, Date.now());
    if (!row) return { requestId, status: "not_found" };
    return {
      requestId,
      status: row.status,
      operation: row.operation,
      createdAt: new Date(row.created_at_ms).toISOString(),
      updatedAt: new Date(row.updated_at_ms).toISOString(),
      ...(row.ref_json
        ? { result: JSON.parse(row.ref_json) as RequestResultRef }
        : {}),
    };
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admission / replay service
// ─────────────────────────────────────────────────────────────────────────────

export type RequestCheckpoint =
  | "prepared"
  | "admitted"
  | "published"
  | "synced"
  | "committed";

/** Whether a recorded plan's side effect is visible on disk. */
export type RequestPlanState = "absent" | "published" | "unexpected";

export type PreparedRequest<TPlan, TResult> =
  | { plan: TPlan; publish: () => Promise<void> }
  | { result: TResult };

export interface RequestedWrite<TPlan, TResult> {
  ledgerPath: string;
  namespace: string;
  requestId: string;
  operation: RequestOperation;
  digest: string;
  lockPath: string;
  lockWaitMs?: number;
  /** Plan against current state under the lease; must not write. Throwing rejects the request. */
  prepare: () => Promise<PreparedRequest<TPlan, TResult>>;
  /** Classify a recorded plan after an interrupted attempt. */
  inspect: (plan: TPlan) => Promise<RequestPlanState>;
  /** Complete a published plan up to the operation's committed boundary. */
  finish: (plan: TPlan) => Promise<TResult>;
  resultRef: (result: TResult) => RequestResultRef;
  now?: () => number;
  /** Deterministic fault injection for tests. */
  checkpoint?: (stage: RequestCheckpoint) => Promise<void> | void;
}

export interface RequestedWriteResult<TResult> {
  result: TResult;
  request: RequestReceiptInfo;
}

function replayTerminal<TResult>(
  row: LedgerRow | null,
  write: Pick<RequestedWrite<unknown, TResult>, "digest" | "requestId">
): RequestedWriteResult<TResult> | null {
  if (!row) return null;
  if (row.status === "expired") {
    throw new RequestReceiptError(
      "REQUEST_EXPIRED",
      `Request ${write.requestId} was already used and its receipt has expired; it will not run again. Check the current state before issuing a new request ID.`
    );
  }
  if (row.digest !== write.digest) {
    throw new RequestReceiptError(
      "REQUEST_ID_CONFLICT",
      `Request ${write.requestId} was already used for a different operation or payload. Use a new request ID for a new intent.`
    );
  }
  if (row.status !== "committed") return null;
  return {
    result: JSON.parse(row.result_json ?? "null") as TResult,
    request: {
      requestId: write.requestId,
      status: "committed",
      replayed: true,
      committedAt: new Date(row.updated_at_ms).toISOString(),
    },
  };
}

/** The shared write lease stayed busy past its wait (`LOCKED: ...`). */
export const isLeaseBusy = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.startsWith(`${MCP_ERRORS.LOCKED.code}:`);

async function runUnderLease<TPlan, TResult>(
  write: RequestedWrite<TPlan, TResult>
): Promise<RequestedWriteResult<TResult>> {
  const now = write.now ?? Date.now;
  const db = await openLedger(write.ledgerPath);
  try {
    const row = getRow(db, write.namespace, write.requestId, now());
    const replay = replayTerminal<TResult>(row, write);
    if (replay) return replay;

    // Under the lease a pending row has no live owner: reconcile it.
    let published: TPlan | null = null;
    if (row?.plan_json) {
      const recorded = JSON.parse(row.plan_json) as TPlan;
      let state = await write.inspect(recorded);
      // Our write landed and has since vanished or been reverted: never
      // recreate it behind the user's back.
      if (state === "absent" && row.published === 1) state = "unexpected";
      if (state === "unexpected") {
        throw new RequestReceiptError(
          "REQUEST_RECOVERY_CONFLICT",
          `Request ${write.requestId} was interrupted and its target changed since; nothing was overwritten. Inspect the target and use a new request ID if the change is still wanted.`
        );
      }
      if (state === "published") published = recorded;
    }

    if (published === null) {
      let prepared: PreparedRequest<TPlan, TResult>;
      try {
        prepared = await write.prepare();
      } catch (error) {
        // Nothing of this request was written: an interrupted receipt that
        // is now rejected is dropped, like any rejection before admission.
        if (row) deleteRow(db, write.namespace, write.requestId);
        throw error;
      }
      await write.checkpoint?.("prepared");
      if ("result" in prepared) {
        if (row) {
          commitRow(
            db,
            write.namespace,
            write.requestId,
            JSON.stringify(prepared.result),
            JSON.stringify(write.resultRef(prepared.result)),
            now()
          );
        } else {
          admitRow(db, {
            namespace: write.namespace,
            requestId: write.requestId,
            operation: write.operation,
            digest: write.digest,
            nowMs: now(),
            status: "committed",
            planJson: null,
            resultJson: JSON.stringify(prepared.result),
            refJson: JSON.stringify(write.resultRef(prepared.result)),
          });
        }
        return {
          result: prepared.result,
          request: {
            requestId: write.requestId,
            status: "committed",
            replayed: false,
            committedAt: new Date(now()).toISOString(),
          },
        };
      }
      const planJson = JSON.stringify(prepared.plan);
      if (row) {
        updatePlan(db, write.namespace, write.requestId, planJson, now());
      } else {
        admitRow(db, {
          namespace: write.namespace,
          requestId: write.requestId,
          operation: write.operation,
          digest: write.digest,
          nowMs: now(),
          status: "pending",
          planJson,
          resultJson: null,
          refJson: null,
        });
      }
      await write.checkpoint?.("admitted");
      try {
        await prepared.publish();
      } catch (error) {
        if ((await write.inspect(prepared.plan)) !== "published") {
          deleteRow(db, write.namespace, write.requestId);
          throw error;
        }
      }
      setPublished(db, write.namespace, write.requestId);
      await write.checkpoint?.("published");
      published = prepared.plan;
    }

    const result = await write.finish(published);
    await write.checkpoint?.("synced");
    const committedAt = now();
    commitRow(
      db,
      write.namespace,
      write.requestId,
      JSON.stringify(result),
      JSON.stringify(write.resultRef(result)),
      committedAt
    );
    await write.checkpoint?.("committed");
    return {
      result,
      request: {
        requestId: write.requestId,
        status: "committed",
        replayed: false,
        committedAt: new Date(committedAt).toISOString(),
      },
    };
  } finally {
    db.close();
  }
}

/**
 * Run one opted-in mutation: replay a committed receipt, reconcile an
 * interrupted one, or admit and execute a new one — exactly once per
 * (namespace, request ID).
 */
export async function runRequestedWrite<TPlan, TResult>(
  write: RequestedWrite<TPlan, TResult>
): Promise<RequestedWriteResult<TResult>> {
  validateRequestId(write.requestId);
  const lookup = async (): Promise<LedgerRow | null> => {
    if (!(await Bun.file(write.ledgerPath).exists())) return null;
    const db = await openLedger(write.ledgerPath);
    try {
      return getRow(
        db,
        write.namespace,
        write.requestId,
        (write.now ?? Date.now)()
      );
    } finally {
      db.close();
    }
  };
  const replay = replayTerminal<TResult>(await lookup(), write);
  if (replay) return replay;
  try {
    return await withWriteLock(
      write.lockPath,
      () => runUnderLease(write),
      write.lockWaitMs
    );
  } catch (error) {
    if (!isLeaseBusy(error)) throw error;
    // The lease holder may be this request's own earlier attempt.
    const current = await lookup();
    const settled = replayTerminal<TResult>(current, write);
    if (settled) return settled;
    if (current?.status === "pending") {
      throw new RequestReceiptError(
        "REQUEST_PENDING",
        `Request ${write.requestId} is accepted and still in progress; retry the same request ID later.`
      );
    }
    throw error;
  }
}
