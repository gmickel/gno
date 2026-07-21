import type { Config } from "../../config/types";

import { getIndexDbPath } from "../../app/constants";
import { indexesMatch } from "../../core/indexed-reference";
import { SqliteAdapter } from "./adapter";

export interface ScopedIndexStore {
  store: SqliteAdapter;
  indexName?: string;
  owned: boolean;
  close(): Promise<void>;
}

export async function openScopedIndexStore(options: {
  activeStore: SqliteAdapter;
  activeIndexName?: string;
  requestedIndexName?: string;
  config: Config;
  configPath: string | null;
}): Promise<ScopedIndexStore> {
  const requestedIndexName =
    options.requestedIndexName ?? options.activeIndexName;
  if (indexesMatch(requestedIndexName, options.activeIndexName)) {
    return {
      store: options.activeStore,
      indexName: requestedIndexName,
      owned: false,
      close: () => Promise.resolve(),
    };
  }

  const dbPath = getIndexDbPath(requestedIndexName);
  if (!(await Bun.file(dbPath).exists())) {
    throw new Error(
      `Index "${requestedIndexName}" does not exist at ${dbPath}`
    );
  }

  const store = new SqliteAdapter();
  store.setConfigPath(options.configPath ?? "<inline-config>");
  const openResult = await store.open(dbPath, options.config.ftsTokenizer);
  if (!openResult.ok) {
    throw new Error(openResult.error.message);
  }

  const collectionsResult = await store.syncCollections(
    options.config.collections
  );
  if (!collectionsResult.ok) {
    await store.close();
    throw new Error(collectionsResult.error.message);
  }

  const contextsResult = await store.syncContexts(
    options.config.contexts ?? []
  );
  if (!contextsResult.ok) {
    await store.close();
    throw new Error(contextsResult.error.message);
  }

  return {
    store,
    indexName: requestedIndexName,
    owned: true,
    close: () => store.close(),
  };
}
