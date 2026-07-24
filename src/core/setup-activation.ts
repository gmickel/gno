import type {
  ActivationVerificationCode,
  ActivationVerificationReceipt,
  StorePort,
  StoreResult,
} from "../store/types";
import type { ConnectorVerificationCode } from "./connector-policy";

import { getConnectorVerificationRemediation } from "./connector-policy";

export const SETUP_ACTIVATION_SCHEMA_VERSION = "1.0" as const;

export type SetupConnectorInstallation = "installed" | "reused" | "failed";
export type SetupConnectorVerification =
  | "passed"
  | "failed"
  | "skipped"
  | "not_run";
export type SetupConnectorCode =
  | "connector_verified"
  | "connector_configuration_unavailable"
  | "connector_install_failed"
  | "connector_verification_failed"
  | ConnectorVerificationCode;

export interface SetupConnectorDefinition {
  id: string;
  kind: "skill" | "mcp";
  target: string;
  scope: "user" | "project";
}

export interface SetupConnectorState extends SetupConnectorDefinition {
  installed: boolean;
  configurationError: boolean;
}

export interface SetupConnectorResult {
  connectorId: string;
  kind: "skill" | "mcp";
  target: string;
  scope: "user" | "project";
  installation: SetupConnectorInstallation;
  verification: SetupConnectorVerification;
  code: SetupConnectorCode;
  remediation: string;
  receipt: ActivationVerificationReceipt | null;
}

export interface SetupConnectorComposition {
  status: "completed" | "completed_with_actions";
  connectors: SetupConnectorResult[];
}

export interface SetupConnectorInstallContext {
  indexName: string;
  configPath: string;
}

export interface SetupConnectorCompositionDeps {
  getStates: () => Promise<SetupConnectorState[]>;
  install: (
    connectorId: string,
    context: SetupConnectorInstallContext
  ) => Promise<SetupConnectorState>;
  verify: (
    connectorId: string,
    store: StorePort,
    collection: string
  ) => Promise<StoreResult<ActivationVerificationReceipt>>;
}

export interface ComposeSetupConnectorsOptions {
  connectorIds: string[];
  definitions: SetupConnectorDefinition[];
  collection: string;
  store: StorePort;
  installContext: SetupConnectorInstallContext;
  deps: SetupConnectorCompositionDeps;
}

const completedRemediation = "No action required.";
const installFailureRemediation =
  "Repair the selected connector configuration or permissions, then rerun the same setup command.";
const configurationFailureRemediation =
  "Repair the selected connector configuration without overwriting it, then rerun the same setup command.";
const verificationFailureRemediation =
  "Retry the same setup command; if verification still fails, run gno doctor.";

function isConnectorVerificationCode(
  code: ActivationVerificationCode | undefined
): code is ConnectorVerificationCode {
  return (
    code === "connector_not_configured" ||
    code === "connector_probe_unavailable" ||
    code === "connector_unsupported_config" ||
    code === "connector_start_failed" ||
    code === "connector_timeout" ||
    code === "connector_missing_tools" ||
    code === "connector_status_failed" ||
    code === "connector_search_failed" ||
    code === "connector_result_mismatch" ||
    code === "target_runtime_unverifiable"
  );
}

function dedupeConnectorIds(connectorIds: string[]): string[] {
  const seen = new Set<string>();
  return connectorIds.filter((connectorId) => {
    if (seen.has(connectorId)) {
      return false;
    }
    seen.add(connectorId);
    return true;
  });
}

function failedResult(
  definition: SetupConnectorDefinition,
  input: {
    installation: SetupConnectorInstallation;
    code:
      | "connector_configuration_unavailable"
      | "connector_install_failed"
      | "connector_verification_failed";
    remediation: string;
  }
): SetupConnectorResult {
  return {
    connectorId: definition.id,
    kind: definition.kind,
    target: definition.target,
    scope: definition.scope,
    installation: input.installation,
    verification:
      input.code === "connector_verification_failed" ? "failed" : "not_run",
    code: input.code,
    remediation: input.remediation,
    receipt: null,
  };
}

function receiptResult(
  definition: SetupConnectorDefinition,
  installation: SetupConnectorInstallation,
  receipt: ActivationVerificationReceipt
): SetupConnectorResult {
  const connectorStage = receipt.stages.connector;
  const verification =
    connectorStage.status === "passed" ||
    connectorStage.status === "failed" ||
    connectorStage.status === "skipped"
      ? connectorStage.status
      : "failed";
  const code =
    connectorStage.status === "passed"
      ? "connector_verified"
      : isConnectorVerificationCode(connectorStage.code)
        ? connectorStage.code
        : "connector_verification_failed";
  const remediation =
    code === "connector_verified"
      ? completedRemediation
      : code === "connector_verification_failed"
        ? verificationFailureRemediation
        : getConnectorVerificationRemediation(code, definition.target);
  return {
    connectorId: definition.id,
    kind: definition.kind,
    target: definition.target,
    scope: definition.scope,
    installation,
    verification,
    code,
    remediation,
    receipt,
  };
}

export function unavailableSetupConnectorComposition(
  definitions: SetupConnectorDefinition[]
): SetupConnectorComposition {
  return {
    status: "completed_with_actions",
    connectors: definitions.map((definition) => ({
      connectorId: definition.id,
      kind: definition.kind,
      target: definition.target,
      scope: definition.scope,
      installation: "failed",
      verification: "not_run",
      code: "connector_verification_failed",
      remediation: verificationFailureRemediation,
      receipt: null,
    })),
  };
}

async function currentStateAfterInstallFailure(
  connectorId: string,
  deps: SetupConnectorCompositionDeps
): Promise<SetupConnectorState | null> {
  try {
    const states = await deps.getStates();
    return states.find(({ id }) => id === connectorId) ?? null;
  } catch {
    return null;
  }
}

async function composeOneConnector(
  definition: SetupConnectorDefinition,
  initialState: SetupConnectorState | null,
  options: ComposeSetupConnectorsOptions
): Promise<SetupConnectorResult> {
  if (!initialState || initialState.configurationError) {
    return failedResult(definition, {
      installation: "failed",
      code: "connector_configuration_unavailable",
      remediation: configurationFailureRemediation,
    });
  }

  let installation: SetupConnectorInstallation = "reused";
  if (!initialState.installed) {
    try {
      const installed = await options.deps.install(
        definition.id,
        options.installContext
      );
      if (!installed.installed || installed.configurationError) {
        return failedResult(definition, {
          installation: "failed",
          code: "connector_install_failed",
          remediation: installFailureRemediation,
        });
      }
      installation = "installed";
    } catch {
      const racedState = await currentStateAfterInstallFailure(
        definition.id,
        options.deps
      );
      if (!racedState?.installed || racedState.configurationError) {
        return failedResult(definition, {
          installation: "failed",
          code: "connector_install_failed",
          remediation: installFailureRemediation,
        });
      }
      installation = "reused";
    }
  }

  try {
    const verification = await options.deps.verify(
      definition.id,
      options.store,
      options.collection
    );
    if (!verification.ok) {
      return failedResult(definition, {
        installation,
        code: "connector_verification_failed",
        remediation: verificationFailureRemediation,
      });
    }
    return receiptResult(definition, installation, verification.value);
  } catch {
    return failedResult(definition, {
      installation,
      code: "connector_verification_failed",
      remediation: verificationFailureRemediation,
    });
  }
}

/**
 * Compose requested connector install/verification after lexical setup.
 * Callers own store lifecycle and validation of connector IDs.
 */
export async function composeSetupConnectors(
  options: ComposeSetupConnectorsOptions
): Promise<SetupConnectorComposition> {
  const requestedIds = dedupeConnectorIds(options.connectorIds);
  let states: SetupConnectorState[] = [];
  try {
    states = await options.deps.getStates();
  } catch {
    // Per-target bounded results below deliberately hide the unbounded error.
  }

  const results: SetupConnectorResult[] = [];
  for (const connectorId of requestedIds) {
    const definition = options.definitions.find(({ id }) => id === connectorId);
    if (!definition) {
      continue;
    }
    const state = states.find(({ id }) => id === connectorId) ?? null;
    results.push(await composeOneConnector(definition, state, options));
  }

  return {
    status: results.every(({ verification }) => verification === "passed")
      ? "completed"
      : "completed_with_actions",
    connectors: results,
  };
}
