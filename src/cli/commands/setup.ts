/**
 * Direct verified-folder setup CLI composition.
 *
 * @module src/cli/commands/setup
 */

// node:readline/promises is the platform line-input API; Bun has no equivalent
// for one default-No terminal confirmation.
import { createInterface } from "node:readline/promises";

import type {
  FolderSetupError,
  FolderSetupOptions,
  FolderSetupResult,
} from "../../core/folder-setup";
import type {
  FolderSetupReceipt,
  SetupStageName,
} from "../../core/setup-receipt";
import type { SqliteAdapter } from "../../store/sqlite/adapter";

import { getIndexDbPath } from "../../app/constants";
import {
  getConfigPaths,
  isInitialized,
  loadConfig,
  toAbsolutePath,
} from "../../config";
import { setupFolder } from "../../core/folder-setup";
import { persistSetupReceipt } from "../../core/setup-receipt";
import { SqliteAdapter as DefaultSqliteAdapter } from "../../store/sqlite/adapter";
import { init } from "./init";
import {
  scheduleSetupSemantic,
  type SetupSemanticReceipt,
} from "./setup-semantic";

export const SETUP_COMMAND_SCHEMA_VERSION = "1.0" as const;

export interface SetupCommandError {
  code: string;
  message: string;
  remediation: string;
}

export interface SetupCommandResult {
  schemaVersion: typeof SETUP_COMMAND_SCHEMA_VERSION;
  status: "completed" | "failed";
  lexical: {
    receipt: FolderSetupReceipt | null;
    error: SetupCommandError | null;
  };
  semantic: SetupSemanticReceipt | null;
}

export interface SetupCommandOptions {
  folder: string;
  name?: string;
  exclude?: string[];
  authorizeSecretRisk?: boolean;
  semantic?: boolean;
  indexName?: string;
  configPath?: string;
  offline?: boolean;
  yes?: boolean;
  json?: boolean;
  quiet?: boolean;
  /** Internal composition flag used after an additive project-profile apply. */
  additiveStoreProjection?: boolean;
  stdinIsTTY?: boolean;
  stderrIsTTY?: boolean;
  progress?: (stage: SetupStageName, receipt: FolderSetupReceipt) => void;
  confirmSecretRisk?: (receipt: FolderSetupReceipt) => Promise<boolean>;
  setupFolderFn?: (options: FolderSetupOptions) => Promise<FolderSetupResult>;
  scheduleSemanticFn?: typeof scheduleSetupSemantic;
  initFn?: typeof init;
  isInitializedFn?: typeof isInitialized;
  createStore?: () => SqliteAdapter;
}

export interface SetupCommandOutcome {
  result: SetupCommandResult;
  exitCode: 0 | 1 | 2;
}

const VALIDATION_ERROR_CODES = new Set([
  "folder_not_found",
  "folder_not_directory",
  "folder_unreadable",
  "dangerous_root",
  "secret_risk",
  "empty_folder",
  "unsupported_only",
  "no_indexable_lexical_corpus",
  "invalid_collection_name",
  "collection_name_conflict",
  "collection_overlap",
  "collection_filter_disagreement",
  "store_index_mismatch",
  "setup_path_overlap",
]);

function commandError(
  code: string,
  message: string,
  remediation: string
): SetupCommandError {
  return { code, message, remediation };
}

function failureOutcome(
  error: SetupCommandError,
  receipt: FolderSetupReceipt | null,
  exitCode: 1 | 2
): SetupCommandOutcome {
  return {
    result: {
      schemaVersion: SETUP_COMMAND_SCHEMA_VERSION,
      status: "failed",
      lexical: { receipt, error },
      semantic: null,
    },
    exitCode,
  };
}

function exitCodeForSetupError(error: FolderSetupError): 1 | 2 {
  return VALIDATION_ERROR_CODES.has(error.code) ? 1 : 2;
}

function firstActiveStage(receipt: FolderSetupReceipt): SetupStageName {
  const stages = Object.entries(receipt.stages);
  const active = stages.find(([, stage]) => stage.status === "in_progress");
  if (active) {
    return active[0] as SetupStageName;
  }
  const failed = stages.find(([, stage]) => stage.status === "failed");
  if (failed) {
    return failed[0] as SetupStageName;
  }
  const lastPassed = stages
    .reverse()
    .find(([, stage]) => stage.status === "passed");
  return (lastPassed?.[0] as SetupStageName | undefined) ?? "preflight";
}

export async function terminalSecretConfirmation(
  receipt: FolderSetupReceipt,
  ask?: (question: string) => Promise<string>
): Promise<boolean> {
  process.stderr.write(
    `Potential secret files detected in ${receipt.input.folder}\n`
  );
  process.stderr.write(
    `Effective exclusions: ${receipt.input.excludes.join(", ") || "(none)"}\n`
  );
  const prompt = ask
    ? null
    : createInterface({
        input: process.stdin,
        output: process.stderr,
      });
  try {
    try {
      const answer = await (ask ?? prompt!.question.bind(prompt))(
        "Index this folder despite the secret-file risk? [y/N] "
      );
      return /^(?:y|yes)$/i.test(answer.trim());
    } catch {
      return false;
    }
  } finally {
    prompt?.close();
  }
}

export function lexicalSuccessIsProven(receipt: FolderSetupReceipt): boolean {
  const resultUri = receipt.activation?.evidence.resultUri;
  return (
    receipt.status === "completed" &&
    receipt.activation?.ready === true &&
    typeof resultUri === "string" &&
    resultUri.length > 0
  );
}

function validateSetupArguments(
  options: SetupCommandOptions
): SetupCommandError | null {
  if (!options.folder.trim()) {
    return commandError(
      "invalid_folder",
      "Folder is required",
      "Pass a readable local folder to `gno setup`."
    );
  }
  if (options.exclude?.some((value) => value.length === 0)) {
    return commandError(
      "invalid_exclusion",
      "--exclude requires a non-empty literal pattern",
      "Remove the empty occurrence or pass a literal exclusion pattern."
    );
  }
  return null;
}

/**
 * Execute the standalone setup transaction. This function returns classified
 * outcomes; the Commander surface owns stdout/stderr rendering.
 */
async function executeSetup(
  options: SetupCommandOptions
): Promise<SetupCommandOutcome> {
  const argumentError = validateSetupArguments(options);
  if (argumentError) {
    return failureOutcome(argumentError, null, 1);
  }

  const paths = getConfigPaths();
  const configPath = toAbsolutePath(options.configPath ?? paths.configFile);
  const dataDir = paths.dataDir;
  const indexName = options.indexName ?? "default";
  const initialized = await (options.isInitializedFn ?? isInitialized)(
    configPath
  );
  if (!initialized) {
    const initializedResult = await (options.initFn ?? init)({
      configPath,
      yes: true,
    });
    if (!initializedResult.success) {
      return failureOutcome(
        commandError(
          "bootstrap_failed",
          initializedResult.error ?? "Failed to initialize GNO",
          "Fix config/data-directory permissions and rerun setup."
        ),
        null,
        2
      );
    }
  }

  const configResult = await loadConfig(configPath);
  if (!configResult.ok) {
    return failureOutcome(
      commandError(
        "config_load_failed",
        configResult.error.message,
        "Repair the selected config and rerun setup."
      ),
      null,
      2
    );
  }

  const store =
    options.createStore?.() ?? (new DefaultSqliteAdapter() as SqliteAdapter);
  store.setConfigPath(configPath);
  const opened = await store.open(
    getIndexDbPath(indexName),
    configResult.value.ftsTokenizer
  );
  if (!opened.ok) {
    await store.close();
    return failureOutcome(
      commandError(
        "store_open_failed",
        opened.error.message,
        "Repair the selected index database and rerun setup."
      ),
      null,
      2
    );
  }

  const setupFolderFn = options.setupFolderFn ?? setupFolder;
  let lastProgress: string | null = null;
  const receiptWriter = async (receipt: FolderSetupReceipt): Promise<void> => {
    await persistSetupReceipt(receipt);
    if (options.quiet || options.json) {
      return;
    }
    const stage = firstActiveStage(receipt);
    const key = stage;
    if (lastProgress !== key) {
      lastProgress = key;
      options.progress?.(stage, receipt);
    }
  };

  const runCore = (authorized: boolean): Promise<FolderSetupResult> =>
    setupFolderFn({
      folder: options.folder,
      store,
      configPath,
      dataDir,
      indexName,
      name: options.name,
      exclude: options.exclude,
      secretRiskAuthorized: authorized,
      additiveStoreProjection: options.additiveStoreProjection,
      receiptWriter,
    });

  try {
    let lexicalResult = await runCore(options.authorizeSecretRisk === true);
    if (
      !lexicalResult.ok &&
      lexicalResult.error.code === "secret_risk" &&
      lexicalResult.receipt &&
      options.authorizeSecretRisk !== true
    ) {
      const mayPrompt =
        options.json !== true &&
        options.yes !== true &&
        (options.stdinIsTTY ?? process.stdin.isTTY ?? false) &&
        (options.stderrIsTTY ?? process.stderr.isTTY ?? false);
      if (mayPrompt) {
        const confirmed = await (
          options.confirmSecretRisk ?? terminalSecretConfirmation
        )(lexicalResult.receipt);
        if (confirmed) {
          lexicalResult = await runCore(true);
        }
      }
    }

    if (!lexicalResult.ok) {
      return failureOutcome(
        lexicalResult.error,
        lexicalResult.receipt,
        exitCodeForSetupError(lexicalResult.error)
      );
    }
    if (!lexicalSuccessIsProven(lexicalResult.receipt)) {
      return failureOutcome(
        commandError(
          "lexical_success_invariant_failed",
          "Setup completed without an exact lexical retrieval result",
          "Rerun setup after repairing the selected index."
        ),
        lexicalResult.receipt,
        2
      );
    }

    const semantic = await (
      options.scheduleSemanticFn ?? scheduleSetupSemantic
    )({
      setupReceipt: lexicalResult.receipt,
      dataDir,
      configPath,
      indexName,
      offline: options.offline ?? false,
      disabled: options.semantic === false,
    });
    return {
      result: {
        schemaVersion: SETUP_COMMAND_SCHEMA_VERSION,
        status: "completed",
        lexical: {
          receipt: lexicalResult.receipt,
          error: null,
        },
        semantic,
      },
      exitCode: 0,
    };
  } finally {
    await store.close();
  }
}

export async function setup(
  options: SetupCommandOptions
): Promise<SetupCommandOutcome> {
  try {
    return await executeSetup(options);
  } catch (error) {
    return failureOutcome(
      commandError(
        "setup_runtime_failed",
        error instanceof Error ? error.message : String(error),
        "Fix the reported local setup error and rerun setup."
      ),
      null,
      2
    );
  }
}

export function formatSetupResult(
  result: SetupCommandResult,
  options: { json: boolean }
): string {
  if (options.json) {
    return JSON.stringify(result, null, 2);
  }
  const receipt = result.lexical.receipt;
  if (result.status === "failed") {
    const error = result.lexical.error;
    return `${error?.code ?? "setup_failed"}: ${error?.message ?? "Setup failed"}. ${error?.remediation ?? ""}`.trim();
  }
  const semantic = result.semantic;
  return [
    `Setup ${receipt?.collection.disposition}: ${receipt?.collection.name}`,
    `result=${receipt?.activation?.evidence.resultUri}`,
    `receipt=${receipt?.paths.receipt}`,
    `semantic=${semantic?.status ?? "pending"}`,
    `resume=${semantic?.resumeCommand ?? "gno embed"}`,
  ].join(" ");
}
