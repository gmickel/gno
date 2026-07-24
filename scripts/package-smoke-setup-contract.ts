/** Deterministic contract proof loaded from the globally installed package. */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { FolderSetupReceipt } from "../src/core/setup-receipt";

import { assertValid, loadSchema } from "../test/spec/schemas/validator";
import {
  assertPackageSmokePathContained,
  buildInstalledSetupChildEnv,
  type InstalledSetupIsolationOptions,
} from "./package-smoke-isolation";
import { verifyInstalledDisabledLiveOwnership } from "./package-smoke-setup-ownership";

export interface InstalledSetupContractOptions extends InstalledSetupIsolationOptions {
  packageRoot: string;
  fixtureDir: string;
  configPath: string;
  dataDir: string;
  lexicalReceipt: FolderSetupReceipt;
}

export type ConnectorByteSnapshot = Record<string, string>;

const moduleUrl = (packageRoot: string, relativePath: string): string =>
  pathToFileURL(join(packageRoot, relativePath)).href;

async function fileSha256(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");
}

/** Hash every installed connector byte so an idempotent rerun cannot overwrite. */
export async function snapshotInstalledConnectorBytes(
  packageRoot: string,
  workspace: { cwd: string; homeDir: string }
): Promise<ConnectorByteSnapshot> {
  const connectors = (await import(
    moduleUrl(packageRoot, "src/serve/connectors.ts")
  )) as typeof import("../src/serve/connectors");
  const statuses = await connectors.getConnectorStatuses(workspace);
  const snapshot: ConnectorByteSnapshot = {};
  for (const status of statuses) {
    if (!status.installed) {
      continue;
    }
    if (status.installKind === "mcp") {
      snapshot[`${status.id}/config`] = await fileSha256(status.path);
      continue;
    }
    const glob = new Bun.Glob("**/*");
    const relativePaths = [
      ...(await Array.fromAsync(
        glob.scan({ cwd: status.path, onlyFiles: true })
      )),
    ].sort();
    for (const relativePath of relativePaths) {
      snapshot[`${status.id}/${relativePath}`] = await fileSha256(
        join(status.path, relativePath)
      );
    }
  }
  return snapshot;
}

function assertNoPrivateError(
  value: unknown,
  privateMarker: string,
  label: string
): void {
  const serialized = JSON.stringify(value);
  if (serialized.includes(privateMarker) || serialized.length > 16_384) {
    throw new Error(`${label} leaked or returned an unbounded child error`);
  }
}

function fakeStore(openResult: unknown, close: () => void) {
  return {
    setConfigPath: () => undefined,
    open: () => Promise.resolve(openResult),
    close: async () => close(),
  };
}

/**
 * Import the published TypeScript modules instead of the source checkout.
 * Injected workers/stores keep the proof offline while exercising the exact
 * package users installed.
 */
export async function verifyInstalledSetupContracts(
  options: InstalledSetupContractOptions
): Promise<void> {
  const collection = options.lexicalReceipt.collection.name;
  if (!collection) {
    throw new Error("Installed setup contract requires a named collection");
  }
  const semanticModule = (await import(
    moduleUrl(options.packageRoot, "src/cli/commands/setup-semantic.ts")
  )) as typeof import("../src/cli/commands/setup-semantic");
  const workerModule = (await import(
    moduleUrl(options.packageRoot, "src/cli/setup-semantic-worker.ts")
  )) as typeof import("../src/cli/setup-semantic-worker");
  const setupModule = (await import(
    moduleUrl(options.packageRoot, "src/cli/commands/setup.ts")
  )) as typeof import("../src/cli/commands/setup");
  const activationModule = (await import(
    moduleUrl(options.packageRoot, "src/cli/commands/setup-activation.ts")
  )) as typeof import("../src/cli/commands/setup-activation");
  const connectorModule = (await import(
    moduleUrl(options.packageRoot, "src/core/setup-activation.ts")
  )) as typeof import("../src/core/setup-activation");

  const semanticSchema = await loadSchema("setup-semantic-receipt");
  const setupSchema = await loadSchema("setup-command-result");
  const activationSchema = await loadSchema("setup-activation-result");
  const semanticDataDir = join(options.dataDir, "installed-contract");
  const base = {
    setupReceipt: options.lexicalReceipt,
    dataDir: semanticDataDir,
    configPath: options.configPath,
    indexName: "default",
    offline: true,
  };

  await verifyInstalledDisabledLiveOwnership({
    packageRoot: options.packageRoot,
    setupReceipt: options.lexicalReceipt,
    dataDir: options.dataDir,
    configPath: options.configPath,
    indexName: "default",
  });

  let concurrentSpawns = 0;
  const concurrentOptions = {
    ...base,
    spawnWorker: async () => {
      concurrentSpawns += 1;
      return { pid: process.pid };
    },
    processIsAlive: (pid: number) => pid === process.pid,
  };
  const [left, right] = await Promise.all([
    semanticModule.scheduleSetupSemantic(concurrentOptions),
    semanticModule.scheduleSetupSemantic(concurrentOptions),
  ]);
  if (
    concurrentSpawns !== 1 ||
    left.jobId !== right.jobId ||
    left.pid !== process.pid ||
    right.pid !== process.pid
  ) {
    throw new Error("Installed semantic scheduler lost concurrent ownership");
  }
  assertValid(left, semanticSchema);

  let replacementSpawns = 0;
  const preserved = await semanticModule.scheduleSetupSemantic({
    ...base,
    offline: false,
    spawnWorker: async () => {
      replacementSpawns += 1;
      return { pid: process.pid + 1 };
    },
    processIsAlive: (pid) => pid === process.pid,
  });
  if (
    replacementSpawns !== 0 ||
    preserved.jobId !== left.jobId ||
    preserved.pid !== process.pid
  ) {
    throw new Error("Installed semantic scheduler replaced a live owner");
  }

  const workerExit = await workerModule.runSetupSemanticWorker(
    left.receiptPath,
    left.jobId,
    {
      embedFn: async () => ({
        success: true,
        embedded: 3,
        errors: 0,
        duration: 1,
        model: "package-contract",
        searchAvailable: true,
      }),
    }
  );
  const completed = await semanticModule.loadSetupSemanticReceipt(
    left.receiptPath
  );
  if (
    workerExit !== 0 ||
    completed?.status !== "completed" ||
    completed.pid !== null ||
    completed.counts?.embedded !== 3
  ) {
    throw new Error("Installed semantic worker did not persist completion");
  }
  assertValid(completed, semanticSchema);

  let completedSpawns = 0;
  const completedRerun = await semanticModule.scheduleSetupSemantic({
    ...base,
    spawnWorker: async () => {
      completedSpawns += 1;
      return { pid: process.pid };
    },
    processIsAlive: () => false,
  });
  if (completedSpawns !== 0 || completedRerun.jobId !== completed.jobId) {
    throw new Error("Installed semantic scheduler did not reuse completion");
  }

  const materialChange: FolderSetupReceipt = {
    ...options.lexicalReceipt,
    fingerprints: {
      ...options.lexicalReceipt.fingerprints,
      index: "a".repeat(64),
    },
  };
  if (
    semanticModule.setupSemanticSourceFingerprint(materialChange) ===
    semanticModule.setupSemanticSourceFingerprint(options.lexicalReceipt)
  ) {
    throw new Error("Installed semantic identity ignored material index state");
  }

  const resumableDataDir = join(options.dataDir, "installed-resume");
  const resumableBase = { ...base, dataDir: resumableDataDir };
  await semanticModule.scheduleSetupSemantic({
    ...resumableBase,
    spawnWorker: async () => ({ pid: 999_999 }),
    processIsAlive: () => false,
  });
  const pending = await semanticModule.scheduleSetupSemantic({
    ...resumableBase,
    spawnWorker: async () => {
      throw new Error("x".repeat(2_000));
    },
    processIsAlive: () => false,
  });
  if (
    pending.status !== "pending" ||
    pending.pid !== null ||
    !pending.error ||
    pending.error.message.length !== 500 ||
    pending.error.remediation !== `Run: ${pending.resumeCommand}`
  ) {
    throw new Error("Installed dead-worker recovery was not bounded/resumable");
  }
  assertValid(pending, semanticSchema);

  const failedDataDir = join(options.dataDir, "installed-failure");
  const scheduledFailure = await semanticModule.scheduleSetupSemantic({
    ...base,
    dataDir: failedDataDir,
    spawnWorker: async () => ({ pid: process.pid }),
    processIsAlive: () => true,
  });
  const failedExit = await workerModule.runSetupSemanticWorker(
    scheduledFailure.receiptPath,
    scheduledFailure.jobId,
    {
      embedFn: () =>
        Promise.resolve({ success: false, error: "model unavailable" }),
    }
  );
  const failed = await semanticModule.loadSetupSemanticReceipt(
    scheduledFailure.receiptPath
  );
  if (
    failedExit !== 2 ||
    failed?.status !== "failed" ||
    failed.pid !== null ||
    failed.error?.message !== "model unavailable" ||
    failed.error.remediation !== `Run: ${failed.resumeCommand}`
  ) {
    throw new Error("Installed semantic worker failure was not resumable");
  }
  assertValid(failed, semanticSchema);

  let setupStoreCloses = 0;
  const openFailure = await setupModule.setup({
    folder: options.fixtureDir,
    configPath: options.configPath,
    semantic: false,
    yes: true,
    json: true,
    createStore: () =>
      fakeStore(
        { ok: false, error: { message: "deterministic open failure" } },
        () => {
          setupStoreCloses += 1;
        }
      ) as never,
  });
  if (
    openFailure.exitCode !== 2 ||
    openFailure.result.status !== "failed" ||
    openFailure.result.lexical.error?.code !== "store_open_failed" ||
    openFailure.result.semantic !== null ||
    setupStoreCloses !== 1
  ) {
    throw new Error("Installed setup store-open lifecycle was not closed");
  }
  assertValid(openFailure.result, setupSchema);

  let activationStoreCloses = 0;
  const activationFailure = await activationModule.setupWithActivation({
    folder: options.fixtureDir,
    name: "package-smoke",
    configPath: options.configPath,
    semantic: false,
    yes: true,
    json: true,
    connectorIds: ["codex-skill"],
    createActivationStore: () =>
      fakeStore(
        { ok: false, error: { message: "activation open failure" } },
        () => {
          activationStoreCloses += 1;
        }
      ) as never,
  });
  if (
    activationFailure.exitCode !== 0 ||
    activationFailure.result.status !== "completed_with_actions" ||
    !("connectors" in activationFailure.result) ||
    activationFailure.result.connectors[0]?.code !==
      "connector_verification_failed" ||
    activationStoreCloses !== 1
  ) {
    throw new Error(
      "Installed post-lexical activation-store failure changed setup success"
    );
  }
  assertValid(activationFailure.result, activationSchema);

  const privateMarker = "private-child-output-must-not-escape";
  const connectorFailure = await connectorModule.composeSetupConnectors({
    connectorIds: ["codex-skill"],
    definitions: [
      {
        id: "codex-skill",
        kind: "skill",
        target: "codex",
        scope: "user",
      },
    ],
    collection,
    store: {} as never,
    installContext: { indexName: "default", configPath: options.configPath },
    deps: {
      getStates: async () => [
        {
          id: "codex-skill",
          kind: "skill",
          target: "codex",
          scope: "user",
          installed: true,
          configurationError: false,
        },
      ],
      install: async () => {
        throw new Error(privateMarker);
      },
      verify: async () => {
        throw new Error(privateMarker);
      },
    },
  });
  if (
    connectorFailure.status !== "completed_with_actions" ||
    connectorFailure.connectors[0]?.code !== "connector_verification_failed" ||
    connectorFailure.connectors[0]?.remediation !==
      "Retry the same setup command; if verification still fails, run gno doctor."
  ) {
    throw new Error("Installed connector failure contract drifted");
  }
  assertNoPrivateError(connectorFailure, privateMarker, "connector contract");

  const installFailure = await connectorModule.composeSetupConnectors({
    connectorIds: ["codex-skill"],
    definitions: [
      {
        id: "codex-skill",
        kind: "skill",
        target: "codex",
        scope: "user",
      },
    ],
    collection,
    store: {} as never,
    installContext: { indexName: "default", configPath: options.configPath },
    deps: {
      getStates: async () => [
        {
          id: "codex-skill",
          kind: "skill",
          target: "codex",
          scope: "user",
          installed: false,
          configurationError: false,
        },
      ],
      install: async () => {
        throw new Error(privateMarker);
      },
      verify: async () => {
        throw new Error("verification must not run after install failure");
      },
    },
  });
  if (
    installFailure.status !== "completed_with_actions" ||
    installFailure.connectors[0]?.code !== "connector_install_failed" ||
    installFailure.connectors[0]?.remediation !==
      "Repair the selected connector configuration or permissions, then rerun the same setup command."
  ) {
    throw new Error("Installed connector install-failure contract drifted");
  }
  assertNoPrivateError(installFailure, privateMarker, "connector install");
}

/** Isolate model-bearing installed imports so their native handles cannot leak. */
export async function verifyInstalledSetupContractsInChild(
  options: InstalledSetupContractOptions
): Promise<void> {
  const inputPath = join(options.dataDir, "installed-contract-input.json");
  await assertPackageSmokePathContained(
    options.tempRoot,
    inputPath,
    "contract input"
  );
  await Bun.write(inputPath, JSON.stringify(options));
  const childEnv = await buildInstalledSetupChildEnv(options);
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "package-smoke-setup-contract-runner.ts"),
      inputPath,
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  if (result.exitCode !== 0) {
    const stdout = result.stdout
      ? new TextDecoder().decode(result.stdout)
      : "(empty)";
    const stderr = result.stderr
      ? new TextDecoder().decode(result.stderr)
      : "(empty)";
    throw new Error(
      [
        `Installed setup contract child exited ${result.exitCode}`,
        `stdout:\n${stdout}`,
        `stderr:\n${stderr}`,
      ].join("\n")
    );
  }
}
