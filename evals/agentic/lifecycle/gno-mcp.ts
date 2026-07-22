import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { Database } from "bun:sqlite";
// node:fs/promises: directory creation, rename, and cleanup have no Bun equivalents.
import { mkdir, rename, rm } from "node:fs/promises";
// node:path: path construction has no Bun equivalent.
import { dirname, join } from "node:path";

import type { AgentToolDefinition } from "../adapter";
import type { CorpusSnapshot, NativeIndexPreparation } from "../types";

import { AgenticHarnessError } from "../adapter";
import { canonicalFingerprint } from "../canonical";
import {
  cleanupNativeIndexPreparation,
  prepareGnoNativeIndex,
} from "../fixture-db";
import {
  GNO_MODEL_LOCK_FINGERPRINT,
  loadAndVerifyGnoModelLock,
  type GnoLockedModel,
  type GnoModelRole,
} from "./gno-mcp-model-lock";

export {
  GNO_MODEL_DIR_ENV,
  loadAndVerifyGnoModelLock,
  validateGnoModelLock,
} from "./gno-mcp-model-lock";

export const GNO_MCP_ADAPTER_ID = "gno-mcp";
export const GNO_MCP_INDEX_NAME = "agentic";
const REQUIRED_PRODUCT_TOOLS = ["gno_query", "gno_get", "gno_multi_get"];
const REPO_ROOT = join(import.meta.dir, "../../..");

export interface GnoMcpProductTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface GnoMcpCallResult {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
}

export interface GnoMcpConnection {
  readonly pid: number | null;
  readonly serverName: string | null;
  readonly serverVersion: string | null;
  listTools(signal?: AbortSignal): Promise<GnoMcpProductTool[]>;
  callTool(
    name: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<GnoMcpCallResult>;
  close(): Promise<void>;
}

export interface GnoMcpPreparedHandle {
  readonly snapshot: CorpusSnapshot;
  readonly native: NativeIndexPreparation;
  readonly configPath: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly indexName: string;
  readonly models: Readonly<Record<GnoModelRole, GnoLockedModel>>;
  readonly productToolsFingerprint: string;
  readonly environment: Readonly<Record<string, string>>;
}

export type GnoMcpConnectionFactory = (
  handle: GnoMcpPreparedHandle,
  signal?: AbortSignal
) => Promise<GnoMcpConnection>;

const modelFileUri = (path: string): string => `file://${path}`;

const writeIsolatedConfig = async (
  native: NativeIndexPreparation,
  configPath: string,
  models: Readonly<Record<GnoModelRole, GnoLockedModel>>
): Promise<void> => {
  const collections = native.taskIds.flatMap((taskId) => {
    const taskRoot = join(native.rootPath, "corpus-snapshot", taskId);
    return [
      ...new Bun.Glob("*").scanSync({ cwd: taskRoot, onlyFiles: false }),
    ].map((collection) => ({
      name: collection,
      path: join(taskRoot, collection),
      pattern: "**/*.md",
      include: [],
      exclude: [],
    }));
  });
  const preset = {
    id: "agentic-locked",
    name: "Agentic locked models",
    embed: modelFileUri(models.embed.path),
    rerank: modelFileUri(models.rerank.path),
    expand: modelFileUri(models.expand.path),
    gen: modelFileUri(models.gen.path),
  };
  await Bun.write(
    configPath,
    `${JSON.stringify(
      {
        version: "1.0",
        ftsTokenizer: "snowball english",
        collections,
        contexts: [],
        contentTypes: [],
        models: {
          activePreset: preset.id,
          presets: [preset],
          loadTimeout: 60_000,
          inferenceTimeout: 30_000,
          expandContextSize: 2048,
          warmModelTtl: 300_000,
        },
      },
      null,
      2
    )}\n`
  );
};

const checkpointNativeIndex = (dbPath: string): void => {
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason;
};

const runOfflineEmbed = async (
  handle: GnoMcpPreparedHandle,
  signal?: AbortSignal
): Promise<void> => {
  throwIfAborted(signal);
  const child = Bun.spawn(
    [
      process.execPath,
      join(REPO_ROOT, "src/index.ts"),
      "--index",
      handle.indexName,
      "--config",
      handle.configPath,
      "--offline",
      "--json",
      "embed",
    ],
    {
      cwd: REPO_ROOT,
      env: handle.environment,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const abortChild = () => child.kill();
  signal?.addEventListener("abort", abortChild, { once: true });
  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
  } finally {
    signal?.removeEventListener("abort", abortChild);
  }
  throwIfAborted(signal);
  if (exitCode !== 0) {
    throw new AgenticHarnessError(
      "gno_offline_embed_failed",
      `Offline GNO embedding failed (${exitCode}): ${stderr.trim() || stdout.trim()}`
    );
  }
};

const verifyEmbeddedIndex = (handle: GnoMcpPreparedHandle): number => {
  const db = new Database(handle.native.dbPath, { readonly: true });
  try {
    const model = modelFileUri(handle.models.embed.path);
    const vectorCount = (
      db
        .query("SELECT COUNT(*) AS count FROM content_vectors WHERE model = ?")
        .get(model) as {
        count: number;
      }
    ).count;
    const chunkCount = (
      db
        .query(
          `SELECT COUNT(*) AS count FROM content_chunks c
           WHERE EXISTS (
             SELECT 1 FROM documents d
             WHERE d.mirror_hash = c.mirror_hash AND d.active = 1
           )`
        )
        .get() as { count: number }
    ).count;
    if (chunkCount === 0 || vectorCount !== chunkCount) {
      throw new AgenticHarnessError(
        "gno_vector_preparation_mismatch",
        `Prepared GNO index vector mismatch: vectors=${vectorCount} chunks=${chunkCount}`
      );
    }
    return vectorCount;
  } finally {
    db.close();
  }
};

const assertProductTool = (
  tools: readonly GnoMcpProductTool[],
  name: string,
  required: readonly string[]
): void => {
  const tool = tools.find((candidate) => candidate.name === name);
  const schema = tool?.inputSchema;
  const properties = schema?.properties;
  if (
    !tool ||
    !schema ||
    schema.type !== "object" ||
    !properties ||
    typeof properties !== "object" ||
    required.some((property) => !(property in properties))
  ) {
    throw new AgenticHarnessError(
      "gno_mcp_tool_contract_mismatch",
      `GNO MCP tool ${name} is missing or incompatible`
    );
  }
};

export const validateGnoProductTools = (
  tools: readonly GnoMcpProductTool[]
): string => {
  assertProductTool(tools, "gno_query", [
    "query",
    "collection",
    "limit",
    "minScore",
    "lang",
    "intent",
    "candidateLimit",
    "exclude",
    "since",
    "until",
    "categories",
    "author",
    "queryModes",
    "fast",
    "thorough",
    "expand",
    "rerank",
    "graph",
    "tagsAll",
    "tagsAny",
  ]);
  assertProductTool(tools, "gno_get", [
    "ref",
    "fromLine",
    "lineCount",
    "lineNumbers",
  ]);
  assertProductTool(tools, "gno_multi_get", [
    "refs",
    "maxBytes",
    "lineNumbers",
  ]);
  return canonicalFingerprint(
    tools
      .filter((tool) => REQUIRED_PRODUCT_TOOLS.includes(tool.name))
      .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"))
  );
};

export const startRealGnoMcpConnection: GnoMcpConnectionFactory = async (
  handle,
  signal
) => {
  const client = new Client({
    name: "gno-agentic-benchmark",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(REPO_ROOT, "src/index.ts"),
      "--index",
      handle.indexName,
      "--config",
      handle.configPath,
      "--offline",
      "mcp",
    ],
    cwd: REPO_ROOT,
    env: handle.environment,
    stderr: "ignore",
  });
  const requestOptions = { signal, timeout: 60_000 };
  try {
    await client.connect(transport, requestOptions);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
  const version = client.getServerVersion();
  return {
    get pid() {
      return transport.pid;
    },
    serverName: version?.name ?? null,
    serverVersion: version?.version ?? null,
    async listTools(callSignal) {
      const response = await client.listTools(undefined, {
        signal: callSignal,
        timeout: 30_000,
      });
      return response.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
    },
    async callTool(name, arguments_, callSignal) {
      return (await client.callTool(
        { name, arguments: arguments_ },
        undefined,
        { signal: callSignal, timeout: 120_000 }
      )) as GnoMcpCallResult;
    },
    async close() {
      await client.close();
    },
  };
};

export interface PrepareGnoMcpOptions {
  modelDir?: string;
  connectionFactory?: GnoMcpConnectionFactory;
  embed?: boolean;
  signal?: AbortSignal;
}

export const prepareGnoMcpHandle = async (
  snapshot: CorpusSnapshot,
  options: PrepareGnoMcpOptions = {}
): Promise<GnoMcpPreparedHandle> => {
  throwIfAborted(options.signal);
  const native = await prepareGnoNativeIndex(snapshot);
  try {
    throwIfAborted(options.signal);
    const configDir = join(native.rootPath, "config");
    const dataDir = join(native.rootPath, "data");
    const cacheDir = join(native.rootPath, "cache");
    const configPath = join(configDir, "index.yml");
    await mkdir(configDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    checkpointNativeIndex(native.dbPath);
    await rename(
      native.dbPath,
      join(dataDir, `index-${GNO_MCP_INDEX_NAME}.sqlite`)
    );
    const models = await loadAndVerifyGnoModelLock(
      options.modelDir,
      options.signal
    );
    throwIfAborted(options.signal);
    await writeIsolatedConfig(native, configPath, models);
    const environment = Object.freeze({
      ...getDefaultEnvironment(),
      GNO_CONFIG_DIR: configDir,
      GNO_DATA_DIR: dataDir,
      GNO_CACHE_DIR: cacheDir,
      GNO_MCP_ACTIVATION_VERIFICATION: "1",
      HF_HUB_OFFLINE: "1",
    });
    const provisional = {
      snapshot,
      native: {
        ...native,
        dbPath: join(dataDir, `index-${GNO_MCP_INDEX_NAME}.sqlite`),
      },
      configPath,
      configDir,
      dataDir,
      cacheDir,
      indexName: GNO_MCP_INDEX_NAME,
      models,
      productToolsFingerprint: "",
      environment,
    } satisfies GnoMcpPreparedHandle;
    if (options.embed !== false) {
      await runOfflineEmbed(provisional, options.signal);
      verifyEmbeddedIndex(provisional);
    }
    throwIfAborted(options.signal);
    const connection = await (
      options.connectionFactory ?? startRealGnoMcpConnection
    )(provisional, options.signal);
    let productToolsFingerprint: string;
    try {
      productToolsFingerprint = validateGnoProductTools(
        await connection.listTools(options.signal)
      );
    } finally {
      await connection.close();
    }
    return Object.freeze({ ...provisional, productToolsFingerprint });
  } catch (error) {
    await cleanupNativeIndexPreparation(native);
    throw error;
  }
};

export const cleanupGnoMcpHandle = async (
  handle: GnoMcpPreparedHandle
): Promise<void> => {
  await rm(handle.native.rootPath, { force: true, recursive: true });
};

export const gnoMcpConfigFingerprint = (): string =>
  canonicalFingerprint({
    adapterId: GNO_MCP_ADAPTER_ID,
    canonicalMapping: "gno-mcp-v1",
    indexName: GNO_MCP_INDEX_NAME,
    modelLock: "gno-models.lock.json",
    modelLockFingerprint: GNO_MODEL_LOCK_FINGERPRINT,
    offline: true,
    productTools: REQUIRED_PRODUCT_TOOLS,
  });

export const normalizedTools = (
  tools: readonly AgentToolDefinition[]
): readonly AgentToolDefinition[] => structuredClone(tools);
