/**
 * Lock-safe, create/update-only application of a compiled project profile.
 *
 * Profile files are inputs only. Config, locks, index state, and receipts stay
 * in user runtime directories outside the trusted profile root.
 *
 * @module src/core/project-profile-apply
 */

// node:fs/promises provides realpath; Bun has no equivalent for canonical path identity.
import { realpath } from "node:fs/promises";
// node:path provides path containment primitives; Bun has no path utilities.
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { Config } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { ProjectProfileDiagnostic } from "./project-profile";
import type { ProjectProfileApplyResource } from "./project-profile-apply-state";
import type {
  ProjectProfileDiff,
  ProjectProfileDiffDiagnostic,
} from "./project-profile-diff";

import { createDefaultConfig } from "../config";
import { saveTextToPath } from "../config/saver";
import { applyConfigChange } from "./config-mutation";
import { compileProjectProfileYaml } from "./project-profile";
import {
  applyProjectProfileDesiredState,
  buildProjectProfileResources,
  canonicalProfileStateEqual,
} from "./project-profile-apply-state";
import { buildProjectProfileDiff } from "./project-profile-diff";

export type {
  ProjectProfileApplyDisposition,
  ProjectProfileApplyResource,
} from "./project-profile-apply-state";

export const PROJECT_PROFILE_APPLY_SCHEMA_VERSION = "1.0" as const;

export interface ProjectProfileApplyReceipt {
  schemaVersion: typeof PROJECT_PROFILE_APPLY_SCHEMA_VERSION;
  command: "apply";
  status: "applied" | "unchanged";
  profile: {
    fingerprint: string;
  };
  diff: ProjectProfileDiff;
  resources: ProjectProfileApplyResource[];
  pendingIndexing: string[];
  diagnostics: ProjectProfileDiffDiagnostic[];
}

export type ProjectProfileApplyErrorCode =
  | "CONFIG_LOAD_FAILED"
  | "CONFIG_SAVE_FAILED"
  | "LOCKED"
  | "PROFILE_INVALID"
  | "RECEIPT_WRITE_FAILED"
  | "RUNTIME_PATH_OVERLAP"
  | "STORE_SYNC_FAILED";

export interface ProjectProfileApplyError {
  code: ProjectProfileApplyErrorCode;
  message: string;
  remediation: string;
  diagnostics?: ProjectProfileDiagnostic[];
}

export type ProjectProfileApplyResult =
  | {
      ok: true;
      receipt: ProjectProfileApplyReceipt;
      receiptPath: string;
    }
  | { ok: false; error: ProjectProfileApplyError };

export interface ProjectProfileApplyOptions {
  profileYaml: string;
  profileRoot: string;
  configPath: string;
  dataDir: string;
  store: SqliteAdapter;
  runtimePaths?: ReadonlyArray<{ label: string; path: string }>;
  canonicalizePath?: (path: string) => Promise<string>;
  onConfigUpdated?: (config: Config) => void;
  receiptWriter?: (
    receipt: ProjectProfileApplyReceipt,
    path: string
  ) => Promise<void>;
  /** Test-only interruption seam after durable config save. */
  failureInjection?: "after_config_save";
}

const isContained = (parent: string, candidate: string): boolean => {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
};

async function canonicalOperationalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const unresolved: string[] = [];
  let candidate = absolute;
  while (true) {
    try {
      return resolve(await realpath(candidate), ...unresolved.reverse());
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return absolute;
      unresolved.push(basename(candidate));
      candidate = parent;
    }
  }
}

export async function validateProjectProfileRuntimePaths(
  profileRoot: string,
  paths: ReadonlyArray<{ label: string; path: string }>
): Promise<ProjectProfileApplyError | null> {
  const canonicalRoot = await canonicalOperationalPath(profileRoot);
  for (const output of paths) {
    const canonicalOutput = await canonicalOperationalPath(output.path);
    if (isContained(canonicalRoot, canonicalOutput)) {
      return {
        code: "RUNTIME_PATH_OVERLAP",
        message: `${output.label} must remain outside the project profile root.`,
        remediation:
          "Choose user config, data, cache, model, lock, and index paths outside the repository.",
      };
    }
  }
  return null;
}

const defaultReceiptWriter = async (
  receipt: ProjectProfileApplyReceipt,
  path: string
): Promise<void> => {
  const saved = await saveTextToPath(
    `${JSON.stringify(receipt, null, 2)}\n`,
    path
  );
  if (!saved.ok) throw new Error(saved.error.message);
};

const mutationFailure = (
  code: string,
  message: string
): ProjectProfileApplyError => {
  if (code === "LOCKED") {
    return {
      code: "LOCKED",
      message: "The project profile apply lock is busy.",
      remediation: "Wait for the concurrent apply to finish, then retry.",
    };
  }
  if (code === "SYNC_ERROR") {
    return {
      code: "STORE_SYNC_FAILED",
      message,
      remediation:
        "Repair the local index store and rerun apply; the saved config is resumable.",
    };
  }
  if (code === "LOAD_ERROR") {
    return {
      code: "CONFIG_LOAD_FAILED",
      message,
      remediation: "Repair the selected user config and rerun apply.",
    };
  }
  return {
    code: "CONFIG_SAVE_FAILED",
    message,
    remediation:
      "Repair user config/data-directory permissions and rerun apply.",
  };
};

export async function applyProjectProfile(
  options: ProjectProfileApplyOptions
): Promise<ProjectProfileApplyResult> {
  const runtimeDir = join(options.dataDir, "project-profiles");
  const receiptPath = join(runtimeDir, "apply-receipt.json");
  const lockPath = join(runtimeDir, "apply.lock");
  const overlap = await validateProjectProfileRuntimePaths(
    options.profileRoot,
    [
      { label: "Config", path: options.configPath },
      { label: "Profile apply receipt", path: receiptPath },
      { label: "Profile apply lock", path: lockPath },
      ...(options.runtimePaths ?? []),
    ]
  );
  if (overlap) return { ok: false, error: overlap };

  let profileFailure: ProjectProfileDiagnostic[] | null = null;
  let receipt: ProjectProfileApplyReceipt | null = null;
  let receiptWriteFailed = false;
  let mutation;
  try {
    mutation = await applyConfigChange(
      {
        store: options.store,
        configPath: options.configPath,
        createConfigIfMissing: createDefaultConfig,
        writeLockPath: lockPath,
        onConfigUpdated: options.onConfigUpdated ?? (() => undefined),
        ...(options.failureInjection === "after_config_save"
          ? {
              afterConfigSaved: () => {
                throw new Error("INJECTED_AFTER_CONFIG_SAVE");
              },
            }
          : {}),
        afterStoreSynced: async () => {
          if (!receipt) throw new Error("MISSING_APPLY_RECEIPT");
          try {
            await (options.receiptWriter ?? defaultReceiptWriter)(
              receipt,
              receiptPath
            );
          } catch {
            receiptWriteFailed = true;
            throw new Error("RECEIPT_WRITE_FAILED");
          }
        },
      },
      async (config) => {
        const compiled = await compileProjectProfileYaml(options.profileYaml, {
          profileRoot: options.profileRoot,
          config,
        });
        if (!compiled.ok) {
          profileFailure = compiled.diagnostics;
          return {
            ok: false,
            code: "PROFILE_INVALID",
            error: "Project profile validation failed.",
          };
        }
        const built = await buildProjectProfileDiff({
          desiredState: compiled.value.desiredState,
          expectedCollectionRoot: compiled.value.resolvedPaths.collectionRoot,
          config,
          canonicalizePath: options.canonicalizePath ?? realpath,
        });
        const nextConfig = applyProjectProfileDesiredState(
          config,
          compiled.value.desiredState,
          compiled.value.resolvedPaths.collectionRoot
        );
        const resources = buildProjectProfileResources(
          config,
          nextConfig,
          built.diff,
          compiled.value.desiredState
        );
        const pendingIndexing = resources.some(
          (resource) => resource.pendingIndexing
        )
          ? [compiled.value.desiredState.collection.name]
          : [];
        receipt = {
          schemaVersion: PROJECT_PROFILE_APPLY_SCHEMA_VERSION,
          command: "apply",
          status: resources.some(
            (resource) =>
              resource.disposition === "created" ||
              resource.disposition === "updated"
          )
            ? "applied"
            : "unchanged",
          profile: { fingerprint: compiled.value.fingerprint },
          diff: built.diff,
          resources,
          pendingIndexing,
          diagnostics: built.diagnostics,
        };
        return {
          ok: true,
          config: nextConfig,
          value: receipt,
          skipSave: canonicalProfileStateEqual(config, nextConfig),
        };
      }
    );
  } catch (error) {
    if (receiptWriteFailed) {
      return {
        ok: false,
        error: {
          code: "RECEIPT_WRITE_FAILED",
          message:
            "Config applied but the external runtime receipt was not saved.",
          remediation:
            "Repair the user data directory and rerun apply; no profile or index deletion occurred.",
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "CONFIG_SAVE_FAILED",
        message:
          error instanceof Error &&
          error.message === "INJECTED_AFTER_CONFIG_SAVE"
            ? "Apply was interrupted after the config save."
            : "Project profile config mutation failed.",
        remediation:
          "Rerun apply; fresh-state diffing and store projection resume idempotently.",
      },
    };
  }

  if (!mutation.ok) {
    if (profileFailure) {
      return {
        ok: false,
        error: {
          code: "PROFILE_INVALID",
          message: "Project profile validation failed.",
          remediation: "Repair .gno/index.yml and rerun apply.",
          diagnostics: profileFailure,
        },
      };
    }
    return {
      ok: false,
      error: mutationFailure(mutation.code, mutation.error),
    };
  }
  const completedReceipt = mutation.value ?? receipt;
  if (!completedReceipt) {
    return {
      ok: false,
      error: {
        code: "CONFIG_SAVE_FAILED",
        message: "Apply completed without a deterministic receipt.",
        remediation: "Rerun apply against the current local state.",
      },
    };
  }
  return { ok: true, receipt: completedReceipt, receiptPath };
}
