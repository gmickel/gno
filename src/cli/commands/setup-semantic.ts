/**
 * Durable, one-shot semantic handoff for `gno setup`.
 *
 * This is deliberately independent of the resident runtime. The setup parent
 * records a local job and starts one detached Bun process; that process embeds
 * the selected collection and exits.
 *
 * @module src/cli/commands/setup-semantic
 */

// node:fs provides append-only descriptors for detached child stdio; Bun.spawn
// accepts numeric descriptors but Bun has no append-open equivalent.
import { closeSync, openSync } from "node:fs";
// node:fs/promises provides private atomic file replacement without a Bun equivalent.
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
// node:path has no Bun path utilities.
import { dirname, join } from "node:path";

import type { FolderSetupReceipt } from "../../core/setup-receipt";

import { VERSION } from "../../app/constants";
import { canonicalizeIndexName } from "../../app/index-name";
import { withWriteLock } from "../../core/file-lock";
import {
  setupFingerprint,
  setupRootFingerprint,
} from "../../core/setup-receipt";
import { isProcessAlive } from "../detach";

export const SETUP_SEMANTIC_SCHEMA_VERSION = "1.0" as const;
export const SETUP_SEMANTIC_STATUSES = [
  "scheduled",
  "running",
  "completed",
  "failed",
  "pending",
  "skipped",
] as const;

export type SetupSemanticStatus = (typeof SETUP_SEMANTIC_STATUSES)[number];

export interface SetupSemanticReceipt {
  schemaVersion: typeof SETUP_SEMANTIC_SCHEMA_VERSION;
  status: SetupSemanticStatus;
  generatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  jobId: string;
  collection: string;
  indexName: string;
  folderFingerprint: string;
  pid: number | null;
  offline: boolean;
  setupReceiptFingerprint: string;
  setupReceiptPath: string;
  receiptPath: string;
  logPath: string;
  resumeCommand: string;
  counts: {
    embedded: number;
    errors: number;
  } | null;
  error: {
    message: string;
    remediation: string;
  } | null;
}

interface SpawnedSemanticWorker {
  pid: number;
}

export interface ScheduleSetupSemanticOptions {
  setupReceipt: FolderSetupReceipt;
  dataDir: string;
  configPath: string;
  indexName: string;
  offline: boolean;
  disabled?: boolean;
  now?: () => Date;
  spawnWorker?: (
    receipt: SetupSemanticReceipt
  ) => Promise<SpawnedSemanticWorker>;
  processIsAlive?: (pid: number) => boolean;
}

const MAX_ERROR_LENGTH = 500;
const MAX_REMEDIATION_LENGTH = 8192;
const LOCK_TIMEOUT_MS = 5000;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SEMANTIC_RECEIPT_KEYS = [
  "schemaVersion",
  "status",
  "generatedAt",
  "startedAt",
  "completedAt",
  "jobId",
  "collection",
  "indexName",
  "folderFingerprint",
  "pid",
  "offline",
  "setupReceiptFingerprint",
  "setupReceiptPath",
  "receiptPath",
  "logPath",
  "resumeCommand",
  "counts",
  "error",
] as const;

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

function boundedMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.slice(0, MAX_ERROR_LENGTH) || "Unknown semantic setup error";
}

function quoteShellArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildSetupSemanticResumeCommand(input: {
  indexName: string;
  configPath: string;
  offline: boolean;
  collection: string;
}): string {
  const flags = [
    "--index",
    quoteShellArg(input.indexName),
    "--config",
    quoteShellArg(input.configPath),
  ];
  if (input.offline) {
    flags.push("--offline");
  }
  return `gno ${flags.join(" ")} embed ${quoteShellArg(input.collection)}`;
}

export function getSetupSemanticReceiptPath(input: {
  dataDir: string;
  indexName: string;
  folderRealpath: string;
}): string {
  return join(
    input.dataDir,
    "setup-semantic",
    canonicalizeIndexName(input.indexName),
    `${setupRootFingerprint(input.folderRealpath)}.json`
  );
}

export function serializeSetupSemanticReceipt(
  receipt: SetupSemanticReceipt
): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export async function persistSetupSemanticReceipt(
  receipt: SetupSemanticReceipt
): Promise<void> {
  if (!isSetupSemanticReceipt(receipt, receipt.receiptPath)) {
    throw new Error("Refusing to persist an invalid semantic setup receipt");
  }
  const receiptDir = dirname(receipt.receiptPath);
  await mkdir(receiptDir, { recursive: true, mode: 0o700 });
  await chmod(receiptDir, 0o700);
  await mkdir(dirname(receipt.logPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(receipt.logPath), 0o700);

  const temporaryPath = `${receipt.receiptPath}.tmp.${crypto.randomUUID()}`;
  let temporaryFile: Awaited<ReturnType<typeof open>> | null = null;
  try {
    temporaryFile = await open(temporaryPath, "wx", 0o600);
    await temporaryFile.writeFile(
      serializeSetupSemanticReceipt(receipt),
      "utf8"
    );
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = null;
    await rename(temporaryPath, receipt.receiptPath);
    await chmod(receipt.receiptPath, 0o600);
  } catch (error) {
    await temporaryFile?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function loadSetupSemanticReceipt(
  path: string
): Promise<SetupSemanticReceipt | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }
  try {
    const value: unknown = await file.json();
    if (!isSetupSemanticReceipt(value, path)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isIsoDate(value: string | null): boolean {
  return value === null || Number.isFinite(Date.parse(value));
}

function hasExactReceiptKeys(receipt: Record<string, unknown>): boolean {
  const expected = new Set<string>(SEMANTIC_RECEIPT_KEYS);
  const keys = Object.keys(receipt);
  return (
    keys.length === SEMANTIC_RECEIPT_KEYS.length &&
    keys.every((key) => expected.has(key))
  );
}

function hasValidStatusState(receipt: SetupSemanticReceipt): boolean {
  switch (receipt.status) {
    case "scheduled":
      return (
        receipt.startedAt === null &&
        receipt.completedAt === null &&
        receipt.counts === null &&
        receipt.error === null
      );
    case "running":
      return (
        receipt.pid !== null &&
        receipt.startedAt !== null &&
        receipt.completedAt === null &&
        receipt.counts === null &&
        receipt.error === null
      );
    case "completed":
      return (
        receipt.pid === null &&
        receipt.completedAt !== null &&
        receipt.counts !== null &&
        receipt.error === null
      );
    case "failed":
      return (
        receipt.pid === null &&
        receipt.completedAt !== null &&
        receipt.error !== null
      );
    case "pending":
      return (
        receipt.completedAt === null &&
        receipt.counts === null &&
        receipt.error !== null
      );
    case "skipped":
      return (
        receipt.completedAt !== null &&
        receipt.counts === null &&
        receipt.error === null
      );
    default:
      return false;
  }
}

function isSetupSemanticReceipt(
  value: unknown,
  expectedPath: string
): value is SetupSemanticReceipt {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const receipt = value as Record<string, unknown>;
  const error = receipt.error;
  const counts = receipt.counts;
  return (
    hasExactReceiptKeys(receipt) &&
    receipt.schemaVersion === SETUP_SEMANTIC_SCHEMA_VERSION &&
    SETUP_SEMANTIC_STATUSES.includes(receipt.status as SetupSemanticStatus) &&
    typeof receipt.generatedAt === "string" &&
    isIsoDate(receipt.generatedAt) &&
    isNullableString(receipt.startedAt) &&
    isIsoDate(receipt.startedAt) &&
    isNullableString(receipt.completedAt) &&
    isIsoDate(receipt.completedAt) &&
    typeof receipt.jobId === "string" &&
    FINGERPRINT_PATTERN.test(receipt.jobId) &&
    typeof receipt.collection === "string" &&
    COLLECTION_PATTERN.test(receipt.collection) &&
    typeof receipt.indexName === "string" &&
    receipt.indexName.length > 0 &&
    receipt.indexName.length <= 64 &&
    typeof receipt.folderFingerprint === "string" &&
    FINGERPRINT_PATTERN.test(receipt.folderFingerprint) &&
    (receipt.pid === null ||
      (typeof receipt.pid === "number" &&
        Number.isInteger(receipt.pid) &&
        receipt.pid > 0)) &&
    typeof receipt.offline === "boolean" &&
    typeof receipt.setupReceiptFingerprint === "string" &&
    FINGERPRINT_PATTERN.test(receipt.setupReceiptFingerprint) &&
    typeof receipt.setupReceiptPath === "string" &&
    receipt.setupReceiptPath.length > 0 &&
    receipt.receiptPath === expectedPath &&
    typeof receipt.logPath === "string" &&
    receipt.logPath.length > 0 &&
    typeof receipt.resumeCommand === "string" &&
    receipt.resumeCommand.startsWith("gno ") &&
    receipt.resumeCommand.includes(" embed ") &&
    (counts === null ||
      (typeof counts === "object" &&
        counts !== null &&
        Object.keys(counts).length === 2 &&
        Number.isInteger((counts as Record<string, unknown>).embedded) &&
        Number((counts as Record<string, unknown>).embedded) >= 0 &&
        Number.isInteger((counts as Record<string, unknown>).errors) &&
        Number((counts as Record<string, unknown>).errors) >= 0)) &&
    (error === null ||
      (typeof error === "object" &&
        error !== null &&
        Object.keys(error).length === 2 &&
        typeof (error as Record<string, unknown>).message === "string" &&
        ((error as Record<string, unknown>).message as string).length > 0 &&
        ((error as Record<string, unknown>).message as string).length <=
          MAX_ERROR_LENGTH &&
        typeof (error as Record<string, unknown>).remediation === "string" &&
        ((error as Record<string, unknown>).remediation as string).length > 0 &&
        ((error as Record<string, unknown>).remediation as string).length <=
          MAX_REMEDIATION_LENGTH)) &&
    hasValidStatusState(receipt as unknown as SetupSemanticReceipt)
  );
}

export function setupSemanticSourceFingerprint(
  receipt: FolderSetupReceipt
): string {
  return setupFingerprint({
    schemaVersion: receipt.schemaVersion,
    status: receipt.status,
    input: receipt.input,
    fingerprints: receipt.fingerprints,
    collection: {
      name: receipt.collection.name,
      path: receipt.collection.path,
    },
    paths: receipt.paths,
    activation: receipt.activation
      ? {
          collection: receipt.activation.collection,
          fingerprint: receipt.activation.fingerprint,
          ready: receipt.activation.ready,
          evidence: receipt.activation.evidence,
        }
      : null,
  });
}

function createSemanticReceipt(
  options: ScheduleSetupSemanticOptions,
  status: SetupSemanticStatus
): SetupSemanticReceipt {
  const setupReceipt = options.setupReceipt;
  const collection = setupReceipt.collection.name;
  if (!collection) {
    throw new Error("Completed setup receipt has no collection");
  }
  const indexName = canonicalizeIndexName(options.indexName);
  const receiptPath = getSetupSemanticReceiptPath({
    dataDir: options.dataDir,
    indexName,
    folderRealpath: setupReceipt.input.folder,
  });
  const generatedAt = nowIso(options.now);
  const setupReceiptFingerprint = setupSemanticSourceFingerprint(setupReceipt);
  return {
    schemaVersion: SETUP_SEMANTIC_SCHEMA_VERSION,
    status,
    generatedAt,
    startedAt: null,
    completedAt: status === "skipped" ? generatedAt : null,
    jobId: setupFingerprint({
      setupReceiptFingerprint,
      packageVersion: VERSION,
      indexName,
      configPath: options.configPath,
      offline: options.offline,
    }),
    collection,
    indexName,
    folderFingerprint: setupReceipt.input.folderFingerprint,
    pid: null,
    offline: options.offline,
    setupReceiptFingerprint,
    setupReceiptPath: setupReceipt.paths.receipt,
    receiptPath,
    logPath: join(
      options.dataDir,
      "setup-semantic",
      indexName,
      `${setupReceipt.input.folderFingerprint}.log`
    ),
    resumeCommand: buildSetupSemanticResumeCommand({
      indexName,
      configPath: options.configPath,
      offline: options.offline,
      collection,
    }),
    counts: null,
    error: null,
  };
}

async function defaultSpawnWorker(
  receipt: SetupSemanticReceipt
): Promise<SpawnedSemanticWorker> {
  const workerPath = join(import.meta.dir, "..", "setup-semantic-worker.ts");
  const descriptor = openSync(receipt.logPath, "a", 0o600);
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, workerPath, receipt.receiptPath, receipt.jobId],
      stdio: ["ignore", descriptor, descriptor],
      detached: true,
      env: process.env,
    });
    child.unref();
    return { pid: child.pid };
  } finally {
    closeSync(descriptor);
  }
}

function existingReceiptMatches(
  existing: SetupSemanticReceipt,
  expected: SetupSemanticReceipt
): boolean {
  return (
    existing.jobId === expected.jobId &&
    existing.collection === expected.collection &&
    existing.indexName === expected.indexName &&
    existing.setupReceiptFingerprint === expected.setupReceiptFingerprint &&
    existing.setupReceiptPath === expected.setupReceiptPath &&
    existing.offline === expected.offline
  );
}

/**
 * Schedule one collection-scoped semantic worker without waiting for model
 * download or embedding.
 */
export async function scheduleSetupSemantic(
  options: ScheduleSetupSemanticOptions
): Promise<SetupSemanticReceipt> {
  const initial = createSemanticReceipt(
    options,
    options.disabled ? "skipped" : "scheduled"
  );
  const lockPath = `${initial.receiptPath}.lock`;

  try {
    return await withWriteLock(
      lockPath,
      async () => {
        const existing = await loadSetupSemanticReceipt(initial.receiptPath);
        const processAlive = options.processIsAlive ?? isProcessAlive;
        if (options.disabled) {
          const existingIsLive =
            existing !== null &&
            (existing.status === "scheduled" ||
              existing.status === "running" ||
              existing.status === "pending" ||
              existing.status === "skipped") &&
            existing.pid !== null &&
            processAlive(existing.pid);
          const skippedBase = existingIsLive ? existing : initial;
          const generatedAt = nowIso(options.now);
          const skipped: SetupSemanticReceipt = {
            ...skippedBase,
            status: "skipped",
            generatedAt,
            completedAt: generatedAt,
            pid: existingIsLive ? existing.pid : null,
            counts: null,
            error: null,
          };
          await persistSetupSemanticReceipt(skipped);
          return skipped;
        }
        if (existing && existingReceiptMatches(existing, initial)) {
          if (existing.status === "completed") {
            return existing;
          }
          if (
            (existing.status === "scheduled" ||
              existing.status === "running" ||
              existing.status === "pending" ||
              existing.status === "skipped") &&
            existing.pid !== null &&
            processAlive(existing.pid)
          ) {
            return existing;
          }
        }
        if (
          existing &&
          !existingReceiptMatches(existing, initial) &&
          (existing.status === "scheduled" ||
            existing.status === "running" ||
            existing.status === "pending" ||
            existing.status === "skipped") &&
          existing.pid !== null &&
          processAlive(existing.pid)
        ) {
          // The active worker owns this receipt identity. Replacing it would
          // make its final update fail the jobId check and strand the durable
          // state. Preserve it; a later setup rerun can schedule the new
          // identity after this process exits.
          return existing;
        }

        await persistSetupSemanticReceipt(initial);
        try {
          const spawned = await (options.spawnWorker ?? defaultSpawnWorker)(
            initial
          );
          const scheduled: SetupSemanticReceipt = {
            ...initial,
            pid: spawned.pid,
            generatedAt: nowIso(options.now),
          };
          await persistSetupSemanticReceipt(scheduled);
          return scheduled;
        } catch (error) {
          const pending: SetupSemanticReceipt = {
            ...initial,
            status: "pending",
            generatedAt: nowIso(options.now),
            error: {
              message: boundedMessage(error),
              remediation: `Run: ${initial.resumeCommand}`,
            },
          };
          await persistSetupSemanticReceipt(pending);
          return pending;
        }
      },
      LOCK_TIMEOUT_MS
    );
  } catch (error) {
    return {
      ...initial,
      status: "pending",
      generatedAt: nowIso(options.now),
      error: {
        message: boundedMessage(error),
        remediation: `Run: ${initial.resumeCommand}`,
      },
    };
  }
}

export async function updateSetupSemanticReceipt(
  receiptPath: string,
  jobId: string,
  update: (
    receipt: SetupSemanticReceipt
  ) => SetupSemanticReceipt | Promise<SetupSemanticReceipt>
): Promise<SetupSemanticReceipt> {
  return withWriteLock(`${receiptPath}.lock`, async () => {
    const receipt = await loadSetupSemanticReceipt(receiptPath);
    if (!receipt || receipt.jobId !== jobId) {
      throw new Error("Semantic setup receipt identity changed");
    }
    const next = await update(receipt);
    await persistSetupSemanticReceipt(next);
    return next;
  });
}
