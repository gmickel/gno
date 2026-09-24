import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for cp/mkdir)
import { cp, mkdir } from "node:fs/promises";
// node:path has no Bun path utilities
import { join } from "node:path";

import { createDefaultConfig } from "../../src/config/defaults";
import { createGnoClient } from "../../src/sdk";
import { GnoSdkError } from "../../src/sdk/errors";
import { addSessionSource, initSessionArchive } from "../../src/sessions/setup";
import { safeRm } from "../helpers/cleanup";
import { FIXTURES, tempDir } from "../sessions/helpers";

let root: string;
let configPath: string;
const env = {
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
  cache: process.env.GNO_CACHE_DIR,
};

beforeAll(async () => {
  root = await tempDir("gno-sdk-sessions-");
  process.env.GNO_CONFIG_DIR = join(root, "gno-config");
  process.env.GNO_DATA_DIR = join(root, "gno-data");
  process.env.GNO_CACHE_DIR = join(root, "gno-cache");
  configPath = join(root, "archive.yml");
  const codexRoot = join(root, "sources", "codex");
  await mkdir(codexRoot, { recursive: true });
  await cp(join(FIXTURES, "codex"), codexRoot, { recursive: true });
  await initSessionArchive({
    configPath,
    indexName: "sessions",
    archiveRoot: join(root, "archive"),
    collection: "work",
  });
  await addSessionSource({
    configPath,
    id: "codex-main",
    harness: "codex",
    path: codexRoot,
    collection: "work",
  });
});

afterAll(async () => {
  process.env.GNO_CONFIG_DIR = env.config;
  process.env.GNO_DATA_DIR = env.data;
  process.env.GNO_CACHE_DIR = env.cache;
  await safeRm(root);
});

describe("SDK sessions", () => {
  test("status, dry run and import share the service receipt", async () => {
    const client = await createGnoClient({ configPath, indexName: "sessions" });
    try {
      const status = await client.sessionsStatus();
      expect(status.sources.map((source) => source.id)).toEqual(["codex-main"]);
      const preview = await client.importSessions({
        sourceId: "codex-main",
        dryRun: true,
      });
      expect(preview.dryRun).toBe(true);
      const receipt = await client.importSessions({ sourceId: "codex-main" });
      expect(receipt.counts.imported).toBe(4);
      expect(receipt.lexical.status).toBe("ready");
      const results = await client.search("SQLite", {
        tagsAll: ["role/human"],
      });
      expect(results.results).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  test("a curated config cannot open the archive index", async () => {
    let error: unknown;
    try {
      await createGnoClient({
        config: createDefaultConfig(),
        indexName: "sessions",
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(GnoSdkError);
    expect((error as GnoSdkError).details?.code).toBe(
      "SESSIONS_BINDING_MISMATCH"
    );
  });

  test("session methods on a non-archive client fail with a stable code", async () => {
    const client = await createGnoClient({ config: createDefaultConfig() });
    try {
      let error: unknown;
      try {
        await client.sessionsStatus();
      } catch (cause) {
        error = cause;
      }
      expect((error as GnoSdkError).code).toBe("VALIDATION");
      expect((error as GnoSdkError).details?.code).toBe(
        "SESSIONS_NOT_CONFIGURED"
      );
    } finally {
      await client.close();
    }
  });
});
