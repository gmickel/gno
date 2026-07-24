/**
 * Deterministic, path-redacted comparison of project profile desired state
 * with current local config.
 *
 * @module src/core/project-profile-diff
 */

import type { Config } from "../config/types";
import type { ProjectProfileDesiredState } from "./project-profile";

import { canonicalProjectProfileJson } from "./project-profile";

export interface ProjectProfileChange {
  action: "add" | "update" | "repair" | "review";
  field: string;
  destructive: boolean;
  summary: string;
}

export interface ProjectProfileStaleMapping {
  collection: string;
  reason: "name_changed" | "root_changed";
  choices: ["repair", "remove_explicitly"];
}

export interface ProjectProfileDiff {
  status: "in_sync" | "changes_required";
  changes: ProjectProfileChange[];
  staleMappings: ProjectProfileStaleMapping[];
}

export interface ProjectProfileDiffDiagnostic {
  code: "STALE_PROFILE_MAPPING";
  severity: "warning";
  path: string;
  message: string;
  remediation: string;
}

export interface BuildProjectProfileDiffOptions {
  desiredState: ProjectProfileDesiredState;
  expectedCollectionRoot: string;
  config: Config;
  canonicalizePath: (path: string) => Promise<string>;
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalEqual = (left: unknown, right: unknown): boolean =>
  canonicalProjectProfileJson(left) === canonicalProjectProfileJson(right);

const profileContexts = (desiredState: ProjectProfileDesiredState): string[] =>
  desiredState.contexts.map((context) => context.text).sort(compareCodeUnits);

const configuredContexts = (config: Config, collection: string): string[] =>
  config.contexts
    .filter(
      (context) =>
        context.scopeType === "collection" &&
        context.scopeKey === `${collection}:`
    )
    .map((context) => context.text)
    .sort(compareCodeUnits);

const desiredCollectionRules = (
  desiredState: ProjectProfileDesiredState
): { include: string[]; exclude: string[] } => ({
  include: desiredState.collection.include,
  exclude: desiredState.collection.exclude,
});

const configuredCollectionRules = (
  collection: Config["collections"][number]
): { include: string[]; exclude: string[] } => ({
  include: [collection.pattern, ...collection.include].sort(compareCodeUnits),
  exclude: [...collection.exclude].sort(compareCodeUnits),
});

const modelSelection = (
  config: Config,
  collection: Config["collections"][number]
): string => {
  if (collection.models && Object.keys(collection.models).length > 0) {
    return "collection_override";
  }
  return config.models?.activePreset ?? "slim-tuned";
};

const canonicalizeConfiguredPaths = async (
  config: Config,
  canonicalizePath: (path: string) => Promise<string>
): Promise<Map<string, string>> => {
  const paths = new Map<string, string>();
  for (const collection of config.collections) {
    try {
      paths.set(collection.name, await canonicalizePath(collection.path));
    } catch {
      // Unavailable roots are stale. Never echo their machine-local values.
    }
  }
  return paths;
};

export async function buildProjectProfileDiff(
  options: BuildProjectProfileDiffOptions
): Promise<{
  diff: ProjectProfileDiff;
  diagnostics: ProjectProfileDiffDiagnostic[];
}> {
  const { desiredState, expectedCollectionRoot, config, canonicalizePath } =
    options;
  const changes: ProjectProfileChange[] = [];
  const staleMappings: ProjectProfileStaleMapping[] = [];
  const diagnostics: ProjectProfileDiffDiagnostic[] = [];
  const collectionName = desiredState.collection.name;
  const target = config.collections.find(
    (collection) => collection.name === collectionName
  );
  const canonicalPaths = await canonicalizeConfiguredPaths(
    config,
    canonicalizePath
  );
  const targetRoot = canonicalPaths.get(collectionName);

  if (!target) {
    changes.push({
      action: "add",
      field: "collection",
      destructive: false,
      summary: `Add collection "${collectionName}" from the project profile.`,
    });
  } else {
    if (targetRoot !== expectedCollectionRoot) {
      changes.push({
        action: "repair",
        field: "collection.root",
        destructive: false,
        summary: `Repair the local root mapping for collection "${collectionName}".`,
      });
      staleMappings.push({
        collection: collectionName,
        reason: "root_changed",
        choices: ["repair", "remove_explicitly"],
      });
    }
    if (
      !canonicalEqual(
        configuredCollectionRules(target),
        desiredCollectionRules(desiredState)
      )
    ) {
      changes.push({
        action: "update",
        field: "collection.rules",
        destructive: false,
        summary: "Update portable include and exclude rules.",
      });
    }
    if (target.languageHint !== desiredState.collection.languageHint) {
      changes.push({
        action: "update",
        field: "collection.languageHint",
        destructive: false,
        summary: "Update the collection language hint.",
      });
    }
    if (
      desiredState.collection.modelPreset &&
      modelSelection(config, target) !== desiredState.collection.modelPreset
    ) {
      changes.push({
        action: "update",
        field: "collection.modelPreset",
        destructive: false,
        summary: "Update the collection model preset alias.",
      });
    }
  }

  for (const collection of config.collections) {
    if (
      collection.name !== collectionName &&
      canonicalPaths.get(collection.name) === expectedCollectionRoot
    ) {
      staleMappings.push({
        collection: collection.name,
        reason: "name_changed",
        choices: ["repair", "remove_explicitly"],
      });
      changes.push({
        action: "review",
        field: `collections.${collection.name}`,
        destructive: false,
        summary: `Review stale collection mapping "${collection.name}"; removal is never implicit.`,
      });
    }
  }

  if (
    !canonicalEqual(
      configuredContexts(config, collectionName),
      profileContexts(desiredState)
    )
  ) {
    changes.push({
      action: "update",
      field: "contexts",
      destructive: false,
      summary: "Update collection-scoped profile contexts.",
    });
  }
  if (!canonicalEqual(config.contentTypes ?? [], desiredState.contentTypes)) {
    changes.push({
      action: "update",
      field: "contentTypes",
      destructive: false,
      summary: "Update normalized content type rules.",
    });
  }
  const currentAffinity = config.projectAffinity ?? {
    enabled: true,
    contribution: 0.03,
  };
  if (!canonicalEqual(currentAffinity, desiredState.affinityDefaults)) {
    changes.push({
      action: "update",
      field: "projectAffinity",
      destructive: false,
      summary: "Update bounded project-affinity defaults.",
    });
  }

  changes.sort(
    (left, right) =>
      compareCodeUnits(left.field, right.field) ||
      compareCodeUnits(left.action, right.action)
  );
  staleMappings.sort(
    (left, right) =>
      compareCodeUnits(left.collection, right.collection) ||
      compareCodeUnits(left.reason, right.reason)
  );
  for (const mapping of staleMappings) {
    diagnostics.push({
      code: "STALE_PROFILE_MAPPING",
      severity: "warning",
      path: `collections.${mapping.collection}`,
      message:
        mapping.reason === "root_changed"
          ? `Collection "${mapping.collection}" points at a different local root.`
          : `Collection "${mapping.collection}" maps the selected root under a different name.`,
      remediation: `Choose repair or run gno collection remove ${mapping.collection} explicitly; diff made no changes.`,
    });
  }
  return {
    diff: {
      status: changes.length === 0 ? "in_sync" : "changes_required",
      changes,
      staleMappings,
    },
    diagnostics,
  };
}
