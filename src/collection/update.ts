/**
 * Update collection core logic.
 * Pure function that mutates config - caller handles I/O.
 *
 * @module src/collection/update
 */

import type {
  Collection,
  CollectionModelOverrides,
  Config,
} from "../config/types";
import type { CollectionResult, UpdateCollectionInput } from "./types";

import { CollectionSchema } from "../config";

function normalizeOverrides(
  models?: UpdateCollectionInput["models"]
): CollectionModelOverrides | undefined {
  if (!models) {
    return undefined;
  }

  const entries = Object.entries(models).filter(
    ([, value]) => value !== undefined && value !== null
  );
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries) as CollectionModelOverrides;
}

/**
 * Update a collection in config.
 */
export function updateCollection(
  config: Config,
  input: UpdateCollectionInput
): CollectionResult {
  const collectionName = input.name.toLowerCase();
  const index = config.collections.findIndex((c) => c.name === collectionName);
  if (index < 0) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `Collection "${collectionName}" not found`,
    };
  }

  const current = config.collections[index];
  if (!current) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `Collection "${collectionName}" not found`,
    };
  }

  let nextModels = current.models;
  if (input.models) {
    nextModels = normalizeOverrides({
      ...current.models,
      ...input.models,
    });
  }

  const nextCollection: Collection = {
    ...current,
    models: nextModels,
  };

  const validation = CollectionSchema.safeParse(nextCollection);
  if (!validation.success) {
    return {
      ok: false,
      code: "VALIDATION",
      message: `Invalid collection: ${validation.error.issues[0]?.message ?? "unknown error"}`,
    };
  }

  const nextCollections = [...config.collections];
  nextCollections[index] = validation.data;

  return {
    ok: true,
    config: {
      ...config,
      collections: nextCollections,
    },
    collection: validation.data,
  };
}
