/**
 * Pure create/update-only config projection for project profile apply.
 *
 * @module src/core/project-profile-apply-state
 */

import type { Config } from "../config/types";
import type { ProjectProfileDesiredState } from "./project-profile";
import type { ProjectProfileDiff } from "./project-profile-diff";

import { getPreset } from "../llm/registry";
import {
  canonicalProjectProfileJson,
  projectProfileIncludePattern,
} from "./project-profile";

export type ProjectProfileApplyDisposition =
  | "created"
  | "reused"
  | "updated"
  | "skipped";

export interface ProjectProfileApplyResource {
  kind:
    | "capability"
    | "collection"
    | "content_type"
    | "contexts"
    | "project_affinity"
    | "stale_mapping";
  id: string;
  disposition: ProjectProfileApplyDisposition;
  pendingIndexing: boolean;
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const canonicalProfileStateEqual = (
  left: unknown,
  right: unknown
): boolean =>
  canonicalProjectProfileJson(left) === canonicalProjectProfileJson(right);

const collectionModels = (
  config: Config,
  presetId: string | undefined
): Config["collections"][number]["models"] | undefined => {
  if (!presetId) return undefined;
  const preset = getPreset(config, presetId);
  if (!preset) return undefined;
  return {
    embed: preset.embed,
    rerank: preset.rerank,
    ...(preset.expand ? { expand: preset.expand } : {}),
    gen: preset.gen,
  };
};

export function applyProjectProfileDesiredState(
  config: Config,
  desired: ProjectProfileDesiredState,
  collectionRoot: string
): Config {
  const existingIndex = config.collections.findIndex(
    (collection) => collection.name === desired.collection.name
  );
  const existing =
    existingIndex >= 0 ? config.collections[existingIndex] : undefined;
  const models = collectionModels(config, desired.collection.modelPreset);
  const nextCollection: Config["collections"][number] = {
    name: desired.collection.name,
    path: collectionRoot,
    pattern: projectProfileIncludePattern(desired.collection.include),
    include: [],
    exclude: desired.collection.exclude,
    ...(existing?.updateCmd ? { updateCmd: existing.updateCmd } : {}),
    ...(desired.collection.languageHint
      ? { languageHint: desired.collection.languageHint }
      : existing?.languageHint
        ? { languageHint: existing.languageHint }
        : {}),
    ...(models
      ? { models }
      : existing?.models
        ? { models: existing.models }
        : {}),
  };
  const collections = [...config.collections];
  if (existingIndex >= 0) collections[existingIndex] = nextCollection;
  else collections.push(nextCollection);

  const contexts = [...config.contexts];
  const configuredContexts = new Set(
    contexts
      .filter(
        (context) =>
          context.scopeType === "collection" &&
          context.scopeKey === `${desired.collection.name}:`
      )
      .map((context) => context.text)
  );
  for (const context of desired.contexts) {
    if (!configuredContexts.has(context.text)) {
      contexts.push({
        scopeType: context.scopeType,
        scopeKey: context.scopeKey,
        text: context.text,
      });
      configuredContexts.add(context.text);
    }
  }

  const contentTypes = [...(config.contentTypes ?? [])];
  for (const desiredRule of desired.contentTypes) {
    const index = contentTypes.findIndex((rule) => rule.id === desiredRule.id);
    if (index >= 0) contentTypes[index] = desiredRule;
    else contentTypes.push(desiredRule);
  }

  return {
    ...config,
    collections,
    contexts,
    contentTypes,
  };
}

export function buildProjectProfileResources(
  before: Config,
  after: Config,
  diff: ProjectProfileDiff,
  desired: ProjectProfileDesiredState
): ProjectProfileApplyResource[] {
  const resources: ProjectProfileApplyResource[] = [];
  const beforeCollection = before.collections.find(
    (collection) => collection.name === desired.collection.name
  );
  const afterCollection = after.collections.find(
    (collection) => collection.name === desired.collection.name
  );
  resources.push({
    kind: "collection",
    id: desired.collection.name,
    disposition: beforeCollection
      ? canonicalProfileStateEqual(beforeCollection, afterCollection)
        ? "reused"
        : "updated"
      : "created",
    pendingIndexing: !canonicalProfileStateEqual(
      beforeCollection,
      afterCollection
    ),
  });

  const beforeContextTexts = new Set(
    before.contexts
      .filter(
        (context) =>
          context.scopeType === "collection" &&
          context.scopeKey === `${desired.collection.name}:`
      )
      .map((context) => context.text)
  );
  const missingContexts = desired.contexts.filter(
    (context) => !beforeContextTexts.has(context.text)
  );
  resources.push({
    kind: "contexts",
    id: `${desired.collection.name}:`,
    disposition:
      desired.contexts.length === 0
        ? "skipped"
        : missingContexts.length === 0
          ? "reused"
          : beforeContextTexts.size === 0
            ? "created"
            : "updated",
    pendingIndexing: false,
  });

  const beforeContentTypes = new Map(
    (before.contentTypes ?? []).map((rule) => [rule.id, rule])
  );
  for (const rule of desired.contentTypes) {
    const previous = beforeContentTypes.get(rule.id);
    const disposition = previous
      ? canonicalProfileStateEqual(previous, rule)
        ? "reused"
        : "updated"
      : "created";
    resources.push({
      kind: "content_type",
      id: rule.id,
      disposition,
      pendingIndexing: disposition !== "reused",
    });
  }
  if (desired.contentTypes.length === 0) {
    resources.push({
      kind: "content_type",
      id: "(none declared)",
      disposition: "skipped",
      pendingIndexing: false,
    });
  }

  resources.push({
    kind: "project_affinity",
    id: "profile",
    disposition: "skipped",
    pendingIndexing: false,
  });
  for (const capability of desired.recommendedCapabilities) {
    resources.push({
      kind: "capability",
      id: capability,
      disposition: "skipped",
      pendingIndexing: false,
    });
  }
  for (const mapping of diff.staleMappings) {
    resources.push({
      kind: "stale_mapping",
      id: mapping.collection,
      disposition: "skipped",
      pendingIndexing: false,
    });
  }
  return resources.sort(
    (left, right) =>
      compareCodeUnits(left.kind, right.kind) ||
      compareCodeUnits(left.id, right.id) ||
      compareCodeUnits(left.disposition, right.disposition)
  );
}
