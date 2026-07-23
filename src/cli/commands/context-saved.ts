/** CLI lifecycle for explicitly saved Context Capsules. */

import type { Config } from "../../config/types";
import type { SqliteAdapter } from "../../store/sqlite/adapter";
import type { SavedCapsuleRegistrationRecord } from "../../store/types";

import { DEFAULT_INDEX_NAME } from "../../app/constants";
import { canonicalizeIndexName } from "../../app/index-name";
import {
  canonicalSavedCapsuleRegistryJson,
  listSavedCapsules,
  loadSavedCapsuleFile,
  registerSavedCapsule,
  unregisterSavedCapsule,
} from "../../core/capsule-registry";
import { reverifySavedCapsuleManually } from "../../core/capsule-reverification";
import { CliError } from "../errors";
import { contextCliError } from "./context-build";
import { initStore } from "./shared";

export interface SavedCapsuleCommandOptions {
  configPath?: string;
  indexName?: string;
  format: "terminal" | "json";
}

export interface WatchSavedCapsuleCommandOptions extends SavedCapsuleCommandOptions {
  explicitIndexName?: string;
  question?: string;
  label?: string;
  notify?: boolean;
}

export interface ReverifySavedCapsuleCommandResult {
  output: string;
  operationStatus: "completed" | "failed";
  errorMessage: string | null;
}

const withStore = async <T>(
  options: SavedCapsuleCommandOptions,
  operation: (input: {
    store: SqliteAdapter;
    config: Config;
    indexName: string;
  }) => Promise<T>
): Promise<T> => {
  const indexName = canonicalizeIndexName(
    options.indexName ?? DEFAULT_INDEX_NAME
  );
  const initialized = await initStore({
    configPath: options.configPath,
    indexName,
    syncConfig: true,
    allowEmptyCollections: true,
  });
  if (!initialized.ok) throw new CliError("RUNTIME", initialized.error);
  try {
    return await operation({
      store: initialized.store,
      config: initialized.config,
      indexName,
    });
  } finally {
    await initialized.store.close();
  }
};

const formatRegistration = (
  registration: SavedCapsuleRegistrationRecord
): string =>
  [
    `${registration.registrationId}  ${registration.label ?? registration.capsuleId}`,
    `  file: ${registration.filePath}`,
    `  index: ${registration.indexName}`,
    `  evidence: ${registration.evidence.length}`,
    `  notify: ${registration.notificationPreference}`,
    `  state: ${registration.verification?.affectedQuestionState ?? "not_verified"}`,
  ].join("\n");

export const watchSavedCapsule = async (
  filePath: string,
  options: WatchSavedCapsuleCommandOptions
): Promise<string> => {
  try {
    const loaded = await loadSavedCapsuleFile(filePath);
    const explicit = options.explicitIndexName
      ? canonicalizeIndexName(options.explicitIndexName)
      : undefined;
    if (explicit && explicit !== loaded.capsule.scope.indexName) {
      throw Object.assign(
        new Error(
          `Context Capsule index ${loaded.capsule.scope.indexName} does not match --index ${explicit}`
        ),
        { code: "invalid_filter" }
      );
    }
    return await withStore(
      { ...options, indexName: loaded.capsule.scope.indexName },
      async ({ store, indexName }) => {
        const registration = await registerSavedCapsule(store, indexName, {
          filePath,
          question: options.question,
          label: options.label,
          notificationPreference: options.notify ? "local" : "none",
        });
        return options.format === "json"
          ? canonicalSavedCapsuleRegistryJson(registration)
          : formatRegistration(registration);
      }
    );
  } catch (error) {
    throw contextCliError(error);
  }
};

export const listWatchedCapsules = async (
  options: SavedCapsuleCommandOptions
): Promise<string> =>
  withStore(options, async ({ store }) => {
    const registrations = await listSavedCapsules(store);
    if (options.format === "json") {
      return canonicalSavedCapsuleRegistryJson({
        schemaVersion: "1.0",
        registrations,
      });
    }
    return registrations.length === 0
      ? "No saved Context Capsules are watched."
      : registrations.map(formatRegistration).join("\n\n");
  }).catch((error) => {
    throw contextCliError(error);
  });

export const unwatchSavedCapsule = async (
  registrationId: string,
  options: SavedCapsuleCommandOptions
): Promise<string> =>
  withStore(options, async ({ store }) => {
    await unregisterSavedCapsule(store, registrationId);
    return options.format === "json"
      ? canonicalSavedCapsuleRegistryJson({
          schemaVersion: "1.0",
          registrationId,
          removed: true,
        })
      : `Stopped watching ${registrationId}.`;
  }).catch((error) => {
    throw contextCliError(error);
  });

export const reverifyWatchedCapsule = async (
  registrationId: string,
  options: SavedCapsuleCommandOptions
): Promise<ReverifySavedCapsuleCommandResult> =>
  withStore(options, async ({ store, config, indexName }) => {
    const outcome = await reverifySavedCapsuleManually(registrationId, {
      store,
      config,
      indexName,
    });
    const errorMessage =
      outcome.verification.operationStatus === "failed"
        ? `${outcome.verification.errorCode ?? "verification_failed"}: ${
            outcome.verification.errorMessage ??
            "Saved Context Capsule verification failed"
          }`
        : null;
    const output =
      options.format === "json"
        ? canonicalSavedCapsuleRegistryJson({
            schemaVersion: "1.0",
            registration: outcome.registration,
            verification: outcome.verification,
            receipt: outcome.receipt,
          })
        : [
            formatRegistration(outcome.registration),
            `  operation: ${outcome.verification.operationStatus}`,
            ...(errorMessage ? [`  error: ${errorMessage}`] : []),
          ].join("\n");
    return {
      output,
      operationStatus: outcome.verification.operationStatus,
      errorMessage,
    };
  }).catch((error) => {
    throw contextCliError(error);
  });
