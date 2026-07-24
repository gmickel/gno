import type {
  SetupConnectorCompositionDeps,
  SetupConnectorDefinition,
  SetupConnectorResult,
  SetupConnectorState,
} from "../../core/setup-activation";
import type { SqliteAdapter } from "../../store/sqlite/adapter";
import type {
  SetupCommandOptions,
  SetupCommandOutcome,
  SetupCommandResult,
} from "./setup";

import { getIndexDbPath } from "../../app/constants";
import { getConfigPaths, loadConfig, toAbsolutePath } from "../../config";
import {
  composeSetupConnectors,
  SETUP_ACTIVATION_SCHEMA_VERSION,
  unavailableSetupConnectorComposition,
} from "../../core/setup-activation";
import {
  getConnectorDefinition,
  getConnectorStatuses,
  installConnector,
  verifyInstalledConnector,
} from "../../serve/connectors";
import { SqliteAdapter as DefaultSqliteAdapter } from "../../store/sqlite/adapter";
import {
  formatSetupResult,
  lexicalSuccessIsProven,
  SETUP_COMMAND_SCHEMA_VERSION,
  setup,
} from "./setup";

export interface SetupActivationResult {
  schemaVersion: typeof SETUP_ACTIVATION_SCHEMA_VERSION;
  status: "completed" | "completed_with_actions" | "failed";
  setup: SetupCommandResult;
  connectors: SetupConnectorResult[];
}

export type SetupOutputResult = SetupCommandResult | SetupActivationResult;

export interface SetupOutputOutcome {
  result: SetupOutputResult;
  exitCode: 0 | 1 | 2;
}

export interface SetupProfileAdvisoryInput {
  folder: string;
  collection: string;
}

export interface SetupActivationCommandOptions extends SetupCommandOptions {
  connectorIds?: string[];
  connectorWorkspace?: { cwd?: string; homeDir?: string };
  connectorDeps?: SetupConnectorCompositionDeps;
  createActivationStore?: () => SqliteAdapter;
  discoverProfileAdvisory?: (
    input: SetupProfileAdvisoryInput
  ) => Promise<unknown>;
}

function dedupeConnectorIds(connectorIds: string[]): string[] {
  return [...new Set(connectorIds)];
}

function connectorStateFromStatus(
  status: Awaited<ReturnType<typeof getConnectorStatuses>>[number]
): SetupConnectorState {
  return {
    id: status.id,
    kind: status.installKind,
    target: status.target,
    scope: status.scope,
    installed: status.installed,
    configurationError: Boolean(status.error),
  };
}

function connectorDefinitions(
  connectorIds: string[]
): SetupConnectorDefinition[] | null {
  const definitions: SetupConnectorDefinition[] = [];
  for (const connectorId of connectorIds) {
    const definition = getConnectorDefinition(connectorId);
    if (!definition) {
      return null;
    }
    definitions.push(definition);
  }
  return definitions;
}

function invalidConnectorOutcome(connectorIds: string[]): SetupCommandOutcome {
  const unknown = connectorIds.find(
    (connectorId) => getConnectorDefinition(connectorId) === null
  );
  return {
    result: {
      schemaVersion: SETUP_COMMAND_SCHEMA_VERSION,
      status: "failed",
      lexical: {
        receipt: null,
        error: {
          code: "invalid_connector",
          message: `Unknown connector: ${unknown ?? ""}`.trim(),
          remediation:
            "Run `gno setup --help` and pass one documented connector ID.",
        },
      },
      semantic: null,
    },
    exitCode: 1,
  };
}

function failedSetupActivationOutcome(
  setupOutcome: SetupCommandOutcome
): SetupOutputOutcome {
  return {
    result: {
      schemaVersion: SETUP_ACTIVATION_SCHEMA_VERSION,
      status: "failed",
      setup: setupOutcome.result,
      connectors: [],
    },
    exitCode: setupOutcome.exitCode,
  };
}

function defaultConnectorDeps(
  workspace: { cwd?: string; homeDir?: string } | undefined
): SetupConnectorCompositionDeps {
  return {
    getStates: async () =>
      (await getConnectorStatuses(workspace)).map(connectorStateFromStatus),
    install: async (connectorId, context) =>
      connectorStateFromStatus(
        await installConnector(
          connectorId,
          { reinstall: false },
          {
            ...workspace,
            indexName: context.indexName,
            configPath: context.configPath,
          }
        )
      ),
    verify: async (connectorId, store, collection) =>
      verifyInstalledConnector(
        connectorId,
        store,
        collection,
        undefined,
        workspace
      ),
  };
}

async function discoverProfileAdvisory(
  discover: SetupActivationCommandOptions["discoverProfileAdvisory"],
  input: SetupProfileAdvisoryInput
): Promise<void> {
  if (!discover) {
    return;
  }
  try {
    await discover(input);
  } catch {
    // Advisory discovery cannot mutate or fail verified setup.
  }
}

function withUnavailableConnectors(
  setupResult: SetupCommandResult,
  definitions: SetupConnectorDefinition[]
): SetupOutputOutcome {
  const unavailable = unavailableSetupConnectorComposition(definitions);
  return {
    result: {
      schemaVersion: SETUP_ACTIVATION_SCHEMA_VERSION,
      status: unavailable.status,
      setup: setupResult,
      connectors: unavailable.connectors,
    },
    exitCode: 0,
  };
}

async function closeActivationStore(
  store: SqliteAdapter | null
): Promise<void> {
  if (!store) {
    return;
  }
  try {
    await store.close();
  } catch {
    // Connector cleanup cannot replace proven lexical success.
  }
}

/**
 * Add opt-in connector onboarding beside the unchanged setup result.
 * No-connector calls retain setup-command-result@1.0; connector-mode failures
 * wrap the unchanged failed setup result without running connector actions.
 */
export async function setupWithActivation(
  options: SetupActivationCommandOptions
): Promise<SetupOutputOutcome> {
  const requestedIds = dedupeConnectorIds(options.connectorIds ?? []);
  const definitions = connectorDefinitions(requestedIds);
  if (!definitions) {
    return failedSetupActivationOutcome(invalidConnectorOutcome(requestedIds));
  }

  const {
    connectorIds: _connectorIds,
    connectorWorkspace: _connectorWorkspace,
    connectorDeps: _connectorDeps,
    createActivationStore: _createActivationStore,
    discoverProfileAdvisory: _discoverProfileAdvisory,
    ...setupOptions
  } = options;
  const setupOutcome = await setup(setupOptions);
  if (
    setupOutcome.exitCode !== 0 ||
    setupOutcome.result.status !== "completed"
  ) {
    return definitions.length > 0
      ? failedSetupActivationOutcome(setupOutcome)
      : setupOutcome;
  }

  const lexicalReceipt = setupOutcome.result.lexical.receipt;
  const collection = lexicalReceipt?.collection.name;
  if (
    !lexicalReceipt ||
    !collection ||
    !lexicalSuccessIsProven(lexicalReceipt)
  ) {
    return setupOutcome;
  }

  await discoverProfileAdvisory(options.discoverProfileAdvisory, {
    folder: lexicalReceipt.input.folder,
    collection,
  });
  if (definitions.length === 0) {
    return setupOutcome;
  }

  let store: SqliteAdapter | null = null;
  try {
    const paths = getConfigPaths();
    const configPath = toAbsolutePath(options.configPath ?? paths.configFile);
    const indexName = options.indexName ?? "default";
    const configResult = await loadConfig(configPath);
    if (!configResult.ok) {
      return withUnavailableConnectors(setupOutcome.result, definitions);
    }

    store =
      options.createActivationStore?.() ??
      (new DefaultSqliteAdapter() as SqliteAdapter);
    store.setConfigPath(configPath);
    const opened = await store.open(
      getIndexDbPath(indexName),
      configResult.value.ftsTokenizer
    );
    if (!opened.ok) {
      return withUnavailableConnectors(setupOutcome.result, definitions);
    }

    const composition = await composeSetupConnectors({
      connectorIds: requestedIds,
      definitions,
      collection,
      store,
      installContext: { indexName, configPath },
      deps:
        options.connectorDeps ??
        defaultConnectorDeps(options.connectorWorkspace),
    });
    return {
      result: {
        schemaVersion: SETUP_ACTIVATION_SCHEMA_VERSION,
        status: composition.status,
        setup: setupOutcome.result,
        connectors: composition.connectors,
      },
      exitCode: 0,
    };
  } catch {
    return withUnavailableConnectors(setupOutcome.result, definitions);
  } finally {
    await closeActivationStore(store);
  }
}

function isSetupActivationResult(
  result: SetupOutputResult
): result is SetupActivationResult {
  return "setup" in result;
}

export function formatSetupOutputResult(
  result: SetupOutputResult,
  options: { json: boolean }
): string {
  if (options.json) {
    return JSON.stringify(result, null, 2);
  }
  if (!isSetupActivationResult(result)) {
    return formatSetupResult(result, options);
  }
  const setupOutput = formatSetupResult(result.setup, options);
  const connectorOutput = result.connectors.map(
    (connector) =>
      `connector=${connector.connectorId} installation=${connector.installation} verification=${connector.verification} code=${connector.code} remediation=${connector.remediation}`
  );
  return [setupOutput, ...connectorOutput].join("\n");
}
