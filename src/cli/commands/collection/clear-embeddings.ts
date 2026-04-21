/**
 * gno collection clear-embeddings - Remove stale or all embeddings for a collection.
 */

import { getIndexDbPath } from "../../../app/constants";
import { ensureDirectories, loadConfig } from "../../../config";
import { resolveModelUri } from "../../../llm/registry";
import { SqliteAdapter } from "../../../store/sqlite/adapter";
import { CliError } from "../../errors";

interface ClearEmbeddingsOptions {
  all?: boolean;
  json?: boolean;
}

export async function collectionClearEmbeddings(
  name: string,
  options: ClearEmbeddingsOptions = {}
): Promise<void> {
  const configResult = await loadConfig();
  if (!configResult.ok) {
    throw new CliError(
      "RUNTIME",
      `Failed to load config: ${configResult.error.message}`
    );
  }

  const config = configResult.value;
  const collection = config.collections.find(
    (item) => item.name === name.toLowerCase()
  );
  if (!collection) {
    throw new CliError("VALIDATION", `Collection not found: ${name}`);
  }

  const ensureResult = await ensureDirectories();
  if (!ensureResult.ok) {
    throw new CliError("RUNTIME", ensureResult.error.message);
  }

  const store = new SqliteAdapter();
  const openResult = await store.open(getIndexDbPath(), config.ftsTokenizer);
  if (!openResult.ok) {
    throw new CliError("RUNTIME", openResult.error.message);
  }

  try {
    const mode = options.all ? "all" : "stale";
    const activeModel = resolveModelUri(
      config,
      "embed",
      undefined,
      collection.name
    );
    const result = await store.clearEmbeddingsForCollection(collection.name, {
      mode,
      activeModel,
    });

    if (!result.ok) {
      throw new CliError("RUNTIME", result.error.message);
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
      return;
    }

    const lines = [
      `Cleared ${result.value.deletedVectors} embedding(s) for ${result.value.collection}.`,
      `Mode: ${result.value.mode}`,
    ];
    if (result.value.deletedModels.length > 0) {
      lines.push(`Models: ${result.value.deletedModels.join(", ")}`);
    }
    if (result.value.protectedSharedVectors > 0) {
      lines.push(
        `Retained ${result.value.protectedSharedVectors} shared vector(s) still referenced by other active collections.`
      );
    }
    if (mode === "all") {
      lines.push(`Run: gno embed --collection ${result.value.collection}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  } finally {
    await store.close();
  }
}
