import type { Config } from "../../src/config/types";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { createDefaultConfig } from "../../src/config/defaults";
import { applyConfigChange } from "../../src/core/config-mutation";

const [configPath, collectionName, collectionPath] = process.argv.slice(2);
if (!(configPath && collectionName && collectionPath)) {
  throw new Error("Expected config path, collection name, and collection path");
}

const store = {
  syncCollections: async () => ({ ok: true, value: undefined }),
  syncContexts: async () => ({ ok: true, value: undefined }),
} as unknown as SqliteAdapter;

const result = await applyConfigChange(
  {
    store,
    configPath,
    createConfigIfMissing: createDefaultConfig,
    onConfigUpdated: () => undefined,
  },
  async (config: Config) => {
    await Bun.sleep(75);
    return {
      ok: true as const,
      config: {
        ...config,
        collections: [
          ...config.collections,
          {
            name: collectionName,
            path: collectionPath,
            pattern: "**/*",
            include: [],
            exclude: [],
          },
        ],
      },
    };
  }
);

if (!result.ok) {
  process.stderr.write(`${result.code}: ${result.error}\n`);
  process.exit(1);
}
