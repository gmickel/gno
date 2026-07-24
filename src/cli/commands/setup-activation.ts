import type {
  SetupConnectorCompositionDeps,
  SetupConnectorDefinition,
  SetupConnectorResult,
  SetupConnectorState,
} from "../../core/setup-activation";
import type { SqliteAdapter } from "../../store/sqlite/adapter";
import type { ProjectProfileCommandResult } from "./profile";
import type { ProjectProfileApplyCommandResult } from "./profile-apply";
import type { SetupCommandOutcome, SetupCommandResult } from "./setup";
import type { SetupProfileIntegrationOptions } from "./setup-profile";

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
import {
  applySetupProfile,
  inspectSetupProfile,
  setupOptionsAfterProfileApply,
} from "./setup-profile";

export { formatSetupProfileAdvisory } from "./setup-profile";

export interface SetupActivationResult {
  schemaVersion: typeof SETUP_ACTIVATION_SCHEMA_VERSION;
  status: "completed" | "completed_with_actions" | "failed";
  setup: SetupCommandResult;
  connectors: SetupConnectorResult[];
}

export interface SetupProfileResult {
  schemaVersion: "1.0";
  status: "completed" | "completed_with_actions" | "failed";
  profile: {
    check: ProjectProfileCommandResult;
    apply: ProjectProfileApplyCommandResult | null;
  };
  setup: SetupCommandResult;
  connectors: SetupConnectorResult[];
}

export type SetupOutputResult =
  | SetupCommandResult
  | SetupActivationResult
  | SetupProfileResult;

export interface SetupOutputOutcome {
  result: SetupOutputResult;
  exitCode: 0 | 1 | 2;
}

function isComposedSetupResult(
  result: SetupOutputResult
): result is SetupActivationResult | SetupProfileResult {
  return "setup" in result;
}

export interface SetupActivationCommandOptions extends SetupProfileIntegrationOptions {
  connectorIds?: string[];
  connectorWorkspace?: { cwd?: string; homeDir?: string };
  connectorDeps?: SetupConnectorCompositionDeps;
  createActivationStore?: () => SqliteAdapter;
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

function withProfileResult(
  outcome: SetupOutputOutcome,
  requested: boolean,
  check: ProjectProfileCommandResult | null,
  applied: ProjectProfileApplyCommandResult | null
): SetupOutputOutcome {
  if (!requested || !check) return outcome;
  const setupResult = isComposedSetupResult(outcome.result)
    ? outcome.result.setup
    : outcome.result;
  const connectors = isComposedSetupResult(outcome.result)
    ? outcome.result.connectors
    : [];
  const profileCompleted =
    applied?.status === "applied" || applied?.status === "unchanged";
  return {
    exitCode: outcome.exitCode,
    result: {
      schemaVersion: "1.0",
      status:
        setupResult.status === "failed"
          ? "failed"
          : outcome.result.status === "completed_with_actions" ||
              !profileCompleted
            ? "completed_with_actions"
            : "completed",
      profile: { check, apply: applied },
      setup: setupResult,
      connectors,
    },
  };
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
    applyProfile: _applyProfile,
    inspectProfileAdvisory: _inspectProfileAdvisory,
    applyProfileAdvisory: _applyProfileAdvisory,
    onProfileAdvisory: _onProfileAdvisory,
    onProfileApply: _onProfileApply,
    ...setupOptions
  } = options;
  const profileCheck = await inspectSetupProfile(options);
  const profileApply = await applySetupProfile(options, profileCheck);
  const effectiveSetupOptions = await setupOptionsAfterProfileApply(
    setupOptions,
    profileApply
  );
  const setupOutcome = await setup(effectiveSetupOptions);
  if (
    setupOutcome.exitCode !== 0 ||
    setupOutcome.result.status !== "completed"
  ) {
    const failed =
      definitions.length > 0
        ? failedSetupActivationOutcome(setupOutcome)
        : setupOutcome;
    return withProfileResult(
      failed,
      Boolean(options.applyProfile),
      profileCheck,
      profileApply
    );
  }

  const lexicalReceipt = setupOutcome.result.lexical.receipt;
  const collection = lexicalReceipt?.collection.name;
  if (
    !lexicalReceipt ||
    !collection ||
    !lexicalSuccessIsProven(lexicalReceipt)
  ) {
    return withProfileResult(
      setupOutcome,
      Boolean(options.applyProfile),
      profileCheck,
      profileApply
    );
  }

  if (definitions.length === 0) {
    return withProfileResult(
      setupOutcome,
      Boolean(options.applyProfile),
      profileCheck,
      profileApply
    );
  }

  let store: SqliteAdapter | null = null;
  try {
    const paths = getConfigPaths();
    const configPath = toAbsolutePath(options.configPath ?? paths.configFile);
    const indexName = options.indexName ?? "default";
    const configResult = await loadConfig(configPath);
    if (!configResult.ok) {
      return withProfileResult(
        withUnavailableConnectors(setupOutcome.result, definitions),
        Boolean(options.applyProfile),
        profileCheck,
        profileApply
      );
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
      return withProfileResult(
        withUnavailableConnectors(setupOutcome.result, definitions),
        Boolean(options.applyProfile),
        profileCheck,
        profileApply
      );
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
    return withProfileResult(
      {
        result: {
          schemaVersion: SETUP_ACTIVATION_SCHEMA_VERSION,
          status: composition.status,
          setup: setupOutcome.result,
          connectors: composition.connectors,
        },
        exitCode: 0,
      },
      Boolean(options.applyProfile),
      profileCheck,
      profileApply
    );
  } catch {
    return withProfileResult(
      withUnavailableConnectors(setupOutcome.result, definitions),
      Boolean(options.applyProfile),
      profileCheck,
      profileApply
    );
  } finally {
    await closeActivationStore(store);
  }
}

export function formatSetupOutputResult(
  result: SetupOutputResult,
  options: { json: boolean }
): string {
  if (options.json) {
    return JSON.stringify(result, null, 2);
  }
  if (!isComposedSetupResult(result)) {
    return formatSetupResult(result, options);
  }
  const setupOutput = formatSetupResult(result.setup, options);
  const connectorOutput = result.connectors.map(
    (connector) =>
      `connector=${connector.connectorId} installation=${connector.installation} verification=${connector.verification} code=${connector.code} remediation=${connector.remediation}`
  );
  return [setupOutput, ...connectorOutput].join("\n");
}
