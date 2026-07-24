/**
 * One-shot semantic worker started by `gno setup`.
 *
 * It owns its store/model lifecycle through the existing collection-scoped
 * embed command, updates one durable receipt, and exits.
 *
 * @module src/cli/setup-semantic-worker
 */

import { loadSetupReceipt } from "../core/setup-receipt";
import { embed, type EmbedOptions, type EmbedResult } from "./commands/embed";
import {
  loadSetupSemanticReceipt,
  type SetupSemanticReceipt,
  setupSemanticSourceFingerprint,
  updateSetupSemanticReceipt,
} from "./commands/setup-semantic";

const PARENT_REGISTRATION_TIMEOUT_MS = 2000;
const PARENT_REGISTRATION_POLL_MS = 20;
const MAX_ERROR_LENGTH = 500;

export interface SetupSemanticWorkerDependencies {
  embedFn?: (options: EmbedOptions) => Promise<EmbedResult>;
  now?: () => Date;
}

function boundedError(error: unknown): string {
  return (
    (error instanceof Error ? error.message : String(error)).slice(
      0,
      MAX_ERROR_LENGTH
    ) || "Unknown semantic setup error"
  );
}

async function waitForParentRegistration(
  receiptPath: string,
  jobId: string
): Promise<SetupSemanticReceipt> {
  const deadline = Date.now() + PARENT_REGISTRATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = await loadSetupSemanticReceipt(receiptPath);
    if (
      receipt?.jobId === jobId &&
      (receipt.pid === process.pid ||
        receipt.status === "pending" ||
        receipt.status === "skipped")
    ) {
      return receipt;
    }
    await Bun.sleep(PARENT_REGISTRATION_POLL_MS);
  }
  throw new Error("Setup parent did not register the semantic worker");
}

export async function runSetupSemanticWorker(
  receiptPath: string,
  jobId: string,
  dependencies: SetupSemanticWorkerDependencies = {}
): Promise<number> {
  try {
    const registered = await waitForParentRegistration(receiptPath, jobId);
    if (registered.status === "pending") {
      return 2;
    }
    if (registered.status === "skipped") {
      return 0;
    }

    const setupReceipt = await loadSetupReceipt(registered.setupReceiptPath);
    if (
      !setupReceipt ||
      setupReceipt.status !== "completed" ||
      setupReceipt.collection.name !== registered.collection ||
      setupReceipt.input.indexName !== registered.indexName ||
      setupReceipt.paths.receipt !== registered.setupReceiptPath ||
      setupSemanticSourceFingerprint(setupReceipt) !==
        registered.setupReceiptFingerprint
    ) {
      throw new Error("Lexical setup receipt no longer matches semantic job");
    }

    const startedAt = (dependencies.now ?? (() => new Date()))().toISOString();
    await updateSetupSemanticReceipt(receiptPath, jobId, (current) => ({
      ...current,
      status: "running",
      generatedAt: startedAt,
      startedAt: current.startedAt ?? startedAt,
      completedAt: null,
      pid: process.pid,
      counts: null,
      error: null,
    }));

    const result = await (dependencies.embedFn ?? embed)({
      configPath: setupReceipt.paths.config,
      indexName: registered.indexName,
      collection: registered.collection,
      yes: true,
      json: true,
      offline: registered.offline,
    });
    if (!result.success) {
      throw new Error(result.error);
    }
    if (result.errors > 0 || result.syncError) {
      const completedAt = (
        dependencies.now ?? (() => new Date())
      )().toISOString();
      const message = result.syncError
        ? `Vector index sync failed: ${result.syncError}`
        : `Embedding completed with ${result.errors} failed chunk${result.errors === 1 ? "" : "s"}`;
      await updateSetupSemanticReceipt(receiptPath, jobId, (current) => ({
        ...current,
        status: "failed",
        generatedAt: completedAt,
        completedAt,
        pid: null,
        counts: {
          embedded: result.embedded,
          errors: result.errors,
        },
        error: {
          message: boundedError(message),
          remediation: `Run: ${current.resumeCommand}`,
        },
      }));
      return 2;
    }

    const completedAt = (
      dependencies.now ?? (() => new Date())
    )().toISOString();
    await updateSetupSemanticReceipt(receiptPath, jobId, (current) => ({
      ...current,
      status: "completed",
      generatedAt: completedAt,
      completedAt,
      pid: null,
      counts: {
        embedded: result.embedded,
        errors: result.errors,
      },
      error: null,
    }));
    return 0;
  } catch (error) {
    const completedAt = (
      dependencies.now ?? (() => new Date())
    )().toISOString();
    await updateSetupSemanticReceipt(receiptPath, jobId, (current) => ({
      ...current,
      status: "failed",
      generatedAt: completedAt,
      startedAt: current.startedAt ?? completedAt,
      completedAt,
      pid: null,
      counts: null,
      error: {
        message: boundedError(error),
        remediation: `Run: ${current.resumeCommand}`,
      },
    })).catch(() => undefined);
    return 2;
  }
}

if (import.meta.main) {
  const receiptPath = process.argv[2];
  const jobId = process.argv[3];
  if (!(receiptPath && jobId)) {
    process.exitCode = 1;
  } else {
    process.exitCode = await runSetupSemanticWorker(receiptPath, jobId);
  }
}
