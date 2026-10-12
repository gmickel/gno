/**
 * gno collection rename - Rename a collection
 */

import { CollectionSchema, getCollectionFromScope } from "../../../config";
import { applyConfigChange } from "../../../core/config-mutation";
import { CliError } from "../../errors";
import { initStore, type InitStoreResult } from "../shared";

export async function collectionRename(
  oldName: string,
  newName: string,
  options: { configPath?: string; indexName?: string } = {}
): Promise<void> {
  const oldCollectionName = oldName.toLowerCase();
  const newCollectionName = newName.toLowerCase();

  // Documents are keyed by collection name (URIs, FTS paths, links), so the
  // index cannot rename them in place. Sync in the same locked boundary: the
  // old name's documents go now instead of at some later sync, and the next
  // update indexes the files under the new name.
  const initialized = await initStore({
    configPath: options.configPath,
    indexName: options.indexName,
    syncConfig: false,
    allowStaleCollections: true,
    allowEmptyCollections: true,
  });
  if (!initialized.ok) {
    throw new CliError("RUNTIME", initialized.error);
  }

  try {
    await renameAndSync(initialized, oldCollectionName, newCollectionName);
  } finally {
    await initialized.store.close();
  }

  process.stdout.write(
    `Collection "${oldCollectionName}" renamed to "${newCollectionName}"\n` +
      "Run: gno update to index it under the new name\n"
  );
}

async function renameAndSync(
  initialized: Extract<InitStoreResult, { ok: true }>,
  oldCollectionName: string,
  newCollectionName: string
): Promise<void> {
  const mutation = await applyConfigChange(
    { store: initialized.store, configPath: initialized.actualConfigPath },
    (config) => {
      const collection = config.collections.find(
        (item) => item.name === oldCollectionName
      );
      if (!collection) {
        return {
          ok: false as const,
          error: `Collection "${oldCollectionName}" not found`,
          code: "NOT_FOUND",
        };
      }
      if (config.collections.some((item) => item.name === newCollectionName)) {
        return {
          ok: false as const,
          error: `Collection "${newCollectionName}" already exists`,
          code: "DUPLICATE",
        };
      }
      const validation = CollectionSchema.safeParse({
        ...collection,
        name: newCollectionName,
      });
      if (!validation.success) {
        return {
          ok: false as const,
          error: `Invalid collection name: ${validation.error.issues[0]?.message ?? "unknown error"}`,
          code: "VALIDATION",
        };
      }
      collection.name = newCollectionName;
      for (const context of config.contexts) {
        if (getCollectionFromScope(context.scopeKey) !== oldCollectionName) {
          continue;
        }
        if (context.scopeType === "collection") {
          context.scopeKey = `${newCollectionName}:`;
        } else if (context.scopeType === "prefix") {
          context.scopeKey = context.scopeKey.replace(
            `gno://${oldCollectionName}/`,
            `gno://${newCollectionName}/`
          );
        }
      }
      return { ok: true as const, config };
    }
  );
  if (!mutation.ok) {
    throw new CliError(
      ["NOT_FOUND", "DUPLICATE", "VALIDATION"].includes(mutation.code)
        ? "VALIDATION"
        : "RUNTIME",
      mutation.error
    );
  }
}
