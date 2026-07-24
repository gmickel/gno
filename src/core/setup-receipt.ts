/**
 * Canonical, privacy-bounded receipts for resumable folder setup.
 *
 * @module src/core/setup-receipt
 */

// node:fs/promises provides private file creation, directory permissions, and atomic rename APIs that Bun does not expose.
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
// node:path has no Bun equivalent.
import { dirname, join } from "node:path";

import type { ActivationVerificationReceipt } from "../store/types";

import { canonicalizeIndexName } from "../app/index-name";

export const SETUP_RECEIPT_SCHEMA_VERSION = "1.0" as const;

export const SETUP_STAGE_NAMES = [
  "preflight",
  "config_saved",
  "store_synced",
  "lexical_indexed",
  "lexical_proved",
  "completed",
] as const;

export type SetupStageName = (typeof SETUP_STAGE_NAMES)[number];
export type SetupStageStatus = "pending" | "in_progress" | "passed" | "failed";

export interface SetupStageReceipt {
  status: SetupStageStatus;
  token: string | null;
  startedAt: string | null;
  completedAt: string | null;
  code: string | null;
  remediation: string | null;
}

export interface SetupFailure {
  stage: SetupStageName;
  code: string;
  message: string;
  remediation: string;
}

export interface FolderSetupReceipt {
  schemaVersion: typeof SETUP_RECEIPT_SCHEMA_VERSION;
  status: "in_progress" | "failed" | "completed";
  generatedAt: string;
  input: {
    folder: string;
    folderFingerprint: string;
    indexName: string;
    requestedName: string | null;
    excludes: string[];
    secretRiskAuthorized: boolean;
  };
  fingerprints: {
    input: string;
    config: string | null;
    index: string | null;
  };
  collection: {
    name: string | null;
    path: string;
    disposition: "pending" | "created" | "reused";
  };
  paths: {
    config: string;
    receipt: string;
  };
  stages: Record<SetupStageName, SetupStageReceipt>;
  pending: string[];
  failure: SetupFailure | null;
  activation: ActivationVerificationReceipt | null;
}

type CanonicalJson =
  | boolean
  | null
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function canonicalize(value: unknown): CanonicalJson {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (typeof value === "object") {
    const output: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) {
        output[key] = canonicalize(item);
      }
    }
    return output;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

export function serializeSetupReceipt(receipt: FolderSetupReceipt): string {
  return `${JSON.stringify(canonicalize(receipt), null, 2)}\n`;
}

export function setupFingerprint(value: unknown): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function setupRootFingerprint(folderRealpath: string): string {
  return new Bun.CryptoHasher("sha256").update(folderRealpath).digest("hex");
}

export function getSetupReceiptPath(input: {
  dataDir: string;
  indexName: string;
  folderRealpath: string;
}): string {
  const indexIdentity = canonicalizeIndexName(input.indexName);
  const rootFingerprint = setupRootFingerprint(input.folderRealpath);
  return join(
    input.dataDir,
    "setup-receipts",
    indexIdentity,
    `${rootFingerprint}.json`
  );
}

export function createSetupReceipt(input: {
  now: string;
  folder: string;
  indexName: string;
  requestedName?: string;
  excludes: string[];
  secretRiskAuthorized: boolean;
  configPath: string;
  dataDir: string;
}): FolderSetupReceipt {
  const indexName = canonicalizeIndexName(input.indexName);
  const folderFingerprint = setupRootFingerprint(input.folder);
  const receiptPath = getSetupReceiptPath({
    dataDir: input.dataDir,
    indexName,
    folderRealpath: input.folder,
  });
  const stages = Object.fromEntries(
    SETUP_STAGE_NAMES.map((stage) => [
      stage,
      {
        status: "pending",
        token: null,
        startedAt: null,
        completedAt: null,
        code: null,
        remediation: null,
      },
    ])
  ) as Record<SetupStageName, SetupStageReceipt>;
  const requestedName = input.requestedName?.trim().toLowerCase() || null;

  return {
    schemaVersion: SETUP_RECEIPT_SCHEMA_VERSION,
    status: "in_progress",
    generatedAt: input.now,
    input: {
      folder: input.folder,
      folderFingerprint,
      indexName,
      requestedName,
      excludes: [...new Set(input.excludes)].sort(),
      secretRiskAuthorized: input.secretRiskAuthorized,
    },
    fingerprints: {
      input: setupFingerprint({
        folder: input.folder,
        indexName,
        requestedName,
        excludes: [...new Set(input.excludes)].sort(),
        secretRiskAuthorized: input.secretRiskAuthorized,
      }),
      config: null,
      index: null,
    },
    collection: {
      name: null,
      path: input.folder,
      disposition: "pending",
    },
    paths: {
      config: input.configPath,
      receipt: receiptPath,
    },
    stages,
    pending: [],
    failure: null,
    activation: null,
  };
}

export function startSetupStage(
  receipt: FolderSetupReceipt,
  stage: SetupStageName,
  now: string
): void {
  receipt.status = "in_progress";
  receipt.generatedAt = now;
  receipt.failure = null;
  receipt.stages[stage] = {
    status: "in_progress",
    token: setupFingerprint({
      receipt: receipt.input.folderFingerprint,
      stage,
      startedAt: now,
    }),
    startedAt: now,
    completedAt: null,
    code: null,
    remediation: null,
  };
}

export function passSetupStage(
  receipt: FolderSetupReceipt,
  stage: SetupStageName,
  now: string
): void {
  receipt.generatedAt = now;
  receipt.stages[stage] = {
    ...receipt.stages[stage],
    status: "passed",
    completedAt: now,
    code: null,
    remediation: null,
  };
}

export function failSetupStage(
  receipt: FolderSetupReceipt,
  failure: SetupFailure,
  now: string
): void {
  const current = receipt.stages[failure.stage];
  receipt.status = "failed";
  receipt.generatedAt = now;
  receipt.failure = failure;
  if (current.status !== "passed") {
    receipt.stages[failure.stage] = {
      ...current,
      status: "failed",
      token:
        current.token ??
        setupFingerprint({
          receipt: receipt.input.folderFingerprint,
          stage: failure.stage,
          startedAt: now,
        }),
      startedAt: current.startedAt ?? now,
      completedAt: now,
      code: failure.code,
      remediation: failure.remediation,
    };
  }
}

export async function persistSetupReceipt(
  receipt: FolderSetupReceipt
): Promise<void> {
  const receiptDir = dirname(receipt.paths.receipt);
  await mkdir(receiptDir, { recursive: true, mode: 0o700 });
  await chmod(receiptDir, 0o700);

  const tempPath = `${receipt.paths.receipt}.tmp.${crypto.randomUUID()}`;
  let tempFile: Awaited<ReturnType<typeof open>> | null = null;
  try {
    tempFile = await open(tempPath, "wx", 0o600);
    await tempFile.writeFile(serializeSetupReceipt(receipt), "utf8");
    await tempFile.sync();
    await tempFile.close();
    tempFile = null;
    await rename(tempPath, receipt.paths.receipt);
    await chmod(receipt.paths.receipt, 0o600);
  } catch (error) {
    await tempFile?.close().catch(() => {
      /* best-effort temporary receipt handle cleanup */
    });
    await unlink(tempPath).catch(() => {
      /* best-effort temporary receipt cleanup */
    });
    throw error;
  }
}

export async function loadSetupReceipt(
  path: string
): Promise<FolderSetupReceipt | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }
  const value: unknown = await file.json();
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== SETUP_RECEIPT_SCHEMA_VERSION
  ) {
    return null;
  }
  return value as FolderSetupReceipt;
}
