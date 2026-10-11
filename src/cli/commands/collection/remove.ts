/**
 * gno collection remove - Remove a collection
 */

import { removeCollection } from "../../../collection";
import { applyConfigChange } from "../../../core/config-mutation";
import { CliError } from "../../errors";
import { initStore } from "../shared";

export async function collectionRemove(
  name: string,
  options: { configPath?: string; indexName?: string } = {}
): Promise<void> {
  // Open the index so the removal reaches the store in the same locked
  // boundary: syncing collections deletes the collection row, and its
  // documents follow by cascade. A config-only edit left them active (and
  // counted in the embedding backlog) until some later command synced.
  const initialized = await initStore({
    configPath: options.configPath,
    indexName: options.indexName,
    syncConfig: false,
    allowEmptyCollections: true,
  });
  if (!initialized.ok) {
    throw new CliError("RUNTIME", initialized.error);
  }

  try {
    const mutation = await applyConfigChange(
      { store: initialized.store, configPath: initialized.actualConfigPath },
      (config) => {
        const result = removeCollection(config, { name });
        return result.ok
          ? {
              ok: true as const,
              config: result.config,
              value: result.collection,
            }
          : {
              ok: false as const,
              error: result.message,
              code: result.code,
            };
      }
    );

    if (!mutation.ok) {
      // Map collection error codes to CLI error codes
      const cliCode =
        mutation.code === "VALIDATION" ||
        mutation.code === "NOT_FOUND" ||
        mutation.code === "HAS_REFERENCES"
          ? "VALIDATION"
          : "RUNTIME";
      throw new CliError(cliCode, mutation.error);
    }

    process.stdout.write(
      `Collection "${mutation.value?.name}" removed successfully\n`
    );
  } finally {
    await initialized.store.close();
  }
}
