import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary-directory lifecycle helpers with no Bun equivalent.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os provides the platform temporary directory with no Bun equivalent.
import { tmpdir } from "node:os";
// node:path provides path composition with no Bun equivalent.
import { join } from "node:path";

import type { ToolContext } from "../../src/mcp/server";
import type { SearchResults } from "../../src/pipeline/types";
import type { ServerContext } from "../../src/serve/context";

import { getIndexDbPath } from "../../src/app/constants";
import { search as searchCli } from "../../src/cli/commands/search";
import { createDefaultConfig, saveConfig } from "../../src/config";
import { handleSearch as handleMcpSearch } from "../../src/mcp/tools/search";
import { createGnoClient } from "../../src/sdk";
import { handleSearch as handleRestSearch } from "../../src/serve/routes/api";
import { SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const originalDirs = {
  cache: process.env.GNO_CACHE_DIR,
  config: process.env.GNO_CONFIG_DIR,
  data: process.env.GNO_DATA_DIR,
};

const comparableScores = (results: SearchResults) =>
  results.results.map(({ docid, score }) => ({ docid, score }));

describe("content-type boost surface parity", () => {
  let root: string;
  let configPath: string;
  let config: ReturnType<typeof createDefaultConfig>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-content-boost-parity-"));
    const collectionPath = join(root, "collection");
    process.env.GNO_CONFIG_DIR = join(root, "config");
    process.env.GNO_DATA_DIR = join(root, "data");
    process.env.GNO_CACHE_DIR = join(root, "cache");
    configPath = join(root, "config", "config.yml");

    await mkdir(join(collectionPath, "decisions"), { recursive: true });
    await mkdir(join(collectionPath, "notes"), { recursive: true });
    await Bun.write(
      join(collectionPath, "decisions", "launch.md"),
      "# Launch decision\nShared launch protocol evidence.\n"
    );
    await Bun.write(
      join(collectionPath, "notes", "launch.md"),
      "# Launch note\nShared launch protocol evidence.\n"
    );

    config = createDefaultConfig();
    config.collections = [
      {
        name: "docs",
        path: collectionPath,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ];
    config.contentTypes = [
      {
        id: "decision",
        prefixes: ["decisions/"],
        preset: "decision-note",
        searchBoost: 2,
      },
      {
        id: "note",
        prefixes: ["notes/"],
        preset: "blank",
      },
    ];
    expect((await saveConfig(config, configPath)).ok).toBe(true);

    const client = await createGnoClient({
      configPath,
      downloadPolicy: { allowDownload: false, offline: true },
    });
    await client.update();
    await client.close();
  });

  afterAll(async () => {
    process.env.GNO_CONFIG_DIR = originalDirs.config;
    process.env.GNO_DATA_DIR = originalDirs.data;
    process.env.GNO_CACHE_DIR = originalDirs.cache;
    await safeRm(root);
  });

  test("CLI REST MCP and SDK return identical bounded BM25 promotion", async () => {
    const cliResult = await searchCli("launch protocol", {
      configPath,
      json: true,
      limit: 2,
    });
    expect(cliResult.success).toBe(true);
    if (!cliResult.success) return;

    const store = new SqliteAdapter();
    expect((await store.open(getIndexDbPath(), config.ftsTokenizer)).ok).toBe(
      true
    );
    const context = {
      store,
      config,
      indexName: "default",
      vectorIndex: null,
      embedPort: null,
      expandPort: null,
      answerPort: null,
      rerankPort: null,
      capabilities: {
        answer: false,
        bm25: true,
        hybrid: false,
        vector: false,
      },
    } satisfies ServerContext;
    const restResponse = await handleRestSearch(
      context,
      new Request("http://localhost/api/search", {
        method: "POST",
        body: JSON.stringify({ query: "launch protocol", limit: 2 }),
      })
    );
    expect(restResponse.status).toBe(200);
    const rest = (await restResponse.json()) as SearchResults;

    const mcpResponse = await handleMcpSearch(
      { query: "launch protocol", limit: 2 },
      {
        store,
        config,
        collections: config.collections,
        isShuttingDown: () => false,
        toolMutex: {
          acquire: async () => () => undefined,
        } as ToolContext["toolMutex"],
      } as unknown as ToolContext
    );
    const mcp = mcpResponse.structuredContent as unknown as SearchResults;
    await store.close();

    const sdk = await createGnoClient({
      configPath,
      downloadPolicy: { allowDownload: false, offline: true },
    });
    const sdkResult = await sdk.search("launch protocol", { limit: 2 });
    await sdk.close();

    const expected = comparableScores(cliResult.data);
    expect(comparableScores(rest)).toEqual(expected);
    expect(comparableScores(mcp)).toEqual(expected);
    expect(comparableScores(sdkResult)).toEqual(expected);
    expect(cliResult.data.results[0]?.uri).toContain("/decisions/");
    expect(JSON.stringify(cliResult.data.results)).not.toContain(
      "contentTypeBoost"
    );
  });

  test("optional explain schema accepts the complete boost component", async () => {
    const schema = await loadSchema("search-results");
    const payload = {
      results: [
        {
          docid: "#abcdef12",
          score: 0.55,
          uri: "gno://docs/decisions/launch.md",
          snippet: "launch protocol",
          source: {
            relPath: "decisions/launch.md",
            mime: "text/markdown",
            ext: ".md",
          },
        },
      ],
      meta: {
        query: "launch protocol",
        mode: "hybrid",
        totalResults: 1,
        explain: {
          lines: [{ stage: "fusion", message: "bounded auxiliary scoring" }],
          results: [
            {
              rank: 1,
              docid: "#abcdef12",
              score: 0.55,
              contentTypeBoost: {
                baseScore: 0.5,
                cappedContribution: 0.05,
                combinedAuxiliaryApplied: 0.05,
                combinedAuxiliaryCap: 0.08,
                combinedAuxiliaryRequested: 0.05,
                configuredFactor: 2,
                contentType: "decision",
                finalScore: 0.55,
                rawContribution: 0.05,
                rawScore: 0.5,
                rawScoreKind: "hybrid_blended",
                ruleSource: "configured-id",
                rulesFingerprint: "a".repeat(64),
              },
            },
          ],
        },
      },
    };

    expect(assertValid(payload, schema)).toBe(true);
  });
});
