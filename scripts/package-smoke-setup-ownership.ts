/** Installed semantic ownership proofs used by the package smoke. */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { FolderSetupReceipt } from "../src/core/setup-receipt";

import { assertValid, loadSchema } from "../test/spec/schemas/validator";

interface DisabledLiveOwnershipOptions {
  packageRoot: string;
  setupReceipt: FolderSetupReceipt;
  dataDir: string;
  configPath: string;
  indexName: string;
}

/**
 * Prove `--no-semantic` records skipped intent without replacing or executing
 * the live one-shot owner of the canonical package receipt.
 */
export async function verifyInstalledDisabledLiveOwnership(
  options: DisabledLiveOwnershipOptions
): Promise<void> {
  const moduleUrl = (relativePath: string): string =>
    pathToFileURL(join(options.packageRoot, relativePath)).href;
  const semanticModule = (await import(
    moduleUrl("src/cli/commands/setup-semantic.ts")
  )) as typeof import("../src/cli/commands/setup-semantic");
  const workerModule = (await import(
    moduleUrl("src/cli/setup-semantic-worker.ts")
  )) as typeof import("../src/cli/setup-semantic-worker");
  const base = {
    setupReceipt: options.setupReceipt,
    dataDir: join(options.dataDir, "installed-disabled-live"),
    configPath: options.configPath,
    indexName: options.indexName,
    offline: true,
  };

  let ownerSpawns = 0;
  const owner = await semanticModule.scheduleSetupSemantic({
    ...base,
    spawnWorker: async () => {
      ownerSpawns += 1;
      return { pid: process.pid };
    },
    processIsAlive: (pid) => pid === process.pid,
  });
  let replacementSpawns = 0;
  const disabled = await semanticModule.scheduleSetupSemantic({
    ...base,
    disabled: true,
    spawnWorker: async () => {
      replacementSpawns += 1;
      return { pid: process.pid + 1 };
    },
    processIsAlive: (pid) => pid === process.pid,
  });
  let workerExecutions = 0;
  const workerExit = await workerModule.runSetupSemanticWorker(
    disabled.receiptPath,
    disabled.jobId,
    {
      embedFn: async () => {
        workerExecutions += 1;
        return {
          success: true,
          embedded: 1,
          errors: 0,
          duration: 1,
          model: "must-not-run",
          searchAvailable: true,
        };
      },
    }
  );
  const persisted = await semanticModule.loadSetupSemanticReceipt(
    disabled.receiptPath
  );
  if (
    ownerSpawns !== 1 ||
    replacementSpawns !== 0 ||
    workerExecutions !== 0 ||
    workerExit !== 0 ||
    disabled.status !== "skipped" ||
    disabled.jobId !== owner.jobId ||
    disabled.pid !== owner.pid ||
    disabled.pid !== process.pid ||
    disabled.counts !== null ||
    persisted?.status !== "skipped" ||
    persisted.jobId !== owner.jobId ||
    persisted.pid !== owner.pid
  ) {
    throw new Error(
      "Installed --no-semantic intent replaced or executed a live owner"
    );
  }
  assertValid(disabled, await loadSchema("setup-semantic-receipt"));
}
