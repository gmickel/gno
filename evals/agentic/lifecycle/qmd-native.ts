// node:fs/promises: temporary directory lifecycle and structure operations have no Bun equivalent.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
// node:os: temporary directory discovery has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path: path construction and PATH delimiter have no Bun equivalent.
import { delimiter, dirname, join } from "node:path";

import type { CorpusSnapshot } from "../types";

import { AgenticHarnessError } from "../adapter";
import { canonicalFingerprint } from "../canonical";
import { QMD_MODEL_ROLES } from "../qmd-lock";
import {
  assertQmdCheckoutStillClean,
  hashQmdFile,
  preflightQmd,
  runQmdCommand,
  type QmdCommandRunner,
  type QmdPreflightOptions,
  type QmdPreflightResult,
} from "../qmd-preflight";
import {
  connectQmdMcp,
  validateQmdMcpContract,
  type QmdMcpConnector,
} from "./qmd-mcp";

export interface QmdPreparedHandle {
  preflight: QmdPreflightResult;
  rootPath: string;
  corpusRoot: string;
  configDir: string;
  xdgConfigHome: string;
  xdgCacheHome: string;
  dataPath: string;
  dbPath: string;
  env: Record<string, string>;
  indexFingerprint: string;
  indexFileSha256: string;
  documentCount: number;
  collectionCount: number;
  preparationMs: number;
}

export interface QmdRuntimeClone {
  rootPath: string;
  dbPath: string;
  env: Record<string, string>;
}

export interface QmdNativeServices {
  commandRunner: QmdCommandRunner;
  connector: QmdMcpConnector;
  preflight: typeof preflightQmd;
  cleanup(path: string): Promise<void>;
}

export const defaultQmdNativeServices: QmdNativeServices = {
  commandRunner: runQmdCommand,
  connector: connectQmdMcp,
  preflight: preflightQmd,
  async cleanup(path) {
    await rm(path, { force: true, recursive: true });
  },
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw signal.reason;
};

const copyFileAbortable = async (
  sourcePath: string,
  targetPath: string,
  signal?: AbortSignal
): Promise<void> => {
  throwIfAborted(signal);
  const reader = Bun.file(sourcePath).stream().getReader();
  const writer = Bun.file(targetPath).writer();
  try {
    for (;;) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      await writer.write(chunk.value);
    }
    await writer.end();
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    await Promise.resolve(writer.end()).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
};

const materializeCorpus = async (
  snapshot: CorpusSnapshot,
  corpusRoot: string,
  signal?: AbortSignal
): Promise<Map<string, string>> => {
  const collections = new Map<string, string>();
  for (const file of snapshot.files) {
    throwIfAborted(signal);
    const collectionRoot = join(corpusRoot, file.collection);
    const target = join(collectionRoot, file.relPath);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, file.content);
    throwIfAborted(signal);
    collections.set(file.collection, collectionRoot);
  }
  return collections;
};

const yamlString = (value: string): string => JSON.stringify(value);

const writeQmdConfig = async (
  path: string,
  preflight: QmdPreflightResult,
  collections: Map<string, string>,
  signal?: AbortSignal
): Promise<void> => {
  throwIfAborted(signal);
  const lines = [
    "global_context: Agentic retrieval benchmark corpus snapshot",
    "models:",
    `  embed: ${yamlString(preflight.lock.models.embed.uri)}`,
    `  rerank: ${yamlString(preflight.lock.models.rerank.uri)}`,
    `  generate: ${yamlString(preflight.lock.models.generate.uri)}`,
    "collections:",
  ];
  for (const [name, collectionPath] of [...collections].sort(
    ([left], [right]) => left.localeCompare(right, "en")
  )) {
    lines.push(
      `  ${name}:`,
      `    path: ${yamlString(collectionPath)}`,
      `    pattern: ${yamlString("**/*.md")}`,
      "    includeByDefault: true"
    );
  }
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${lines.join("\n")}\n`);
  throwIfAborted(signal);
};

const copyPinnedModels = async (
  preflight: QmdPreflightResult,
  xdgCacheHome: string,
  signal?: AbortSignal
): Promise<void> => {
  const targetRoot = join(xdgCacheHome, "qmd/models");
  await mkdir(targetRoot, { recursive: true });
  for (const role of QMD_MODEL_ROLES) {
    throwIfAborted(signal);
    const target = join(targetRoot, preflight.lock.models[role].cacheFile);
    await copyFileAbortable(preflight.modelPaths[role], target, signal);
    if (
      (await hashQmdFile(target, signal)) !== preflight.lock.models[role].sha256
    ) {
      throw new AgenticHarnessError(
        "qmd_model_copy_mismatch",
        `Isolated ${role} model copy does not match the lock`
      );
    }
  }
};

const runPinnedQmd = async (
  services: QmdNativeServices,
  handle: Pick<QmdPreparedHandle, "preflight" | "env" | "rootPath">,
  args: readonly string[],
  signal?: AbortSignal
): Promise<string> => {
  const result = await services.commandRunner({
    command: process.execPath,
    args: [handle.preflight.entrypointPath, ...args],
    cwd: handle.rootPath,
    env: handle.env,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new AgenticHarnessError(
      "qmd_command_failed",
      `Pinned qmd ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`
    );
  }
  await assertQmdCheckoutStillClean(
    handle.preflight,
    services.commandRunner,
    signal
  );
  return result.stdout.trim();
};

export const buildQmdEnvironment = (
  paths: {
    configDir: string;
    xdgConfigHome: string;
    xdgCacheHome: string;
    dbPath: string;
  },
  preflight: QmdPreflightResult,
  inherited: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> => {
  const base = Object.fromEntries(
    Object.entries(inherited).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !entry[0].toUpperCase().startsWith("QMD_")
    )
  );
  return {
    ...base,
    PATH: [dirname(process.execPath), base.PATH]
      .filter((value): value is string => !!value)
      .join(delimiter),
    QMD_CONFIG_DIR: paths.configDir,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    XDG_CACHE_HOME: paths.xdgCacheHome,
    INDEX_PATH: paths.dbPath,
    QMD_SOURCE_MODE: "1",
    HF_HUB_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    TRANSFORMERS_OFFLINE: "1",
    QMD_EMBED_MODEL: preflight.lock.models.embed.uri,
    QMD_RERANK_MODEL: preflight.lock.models.rerank.uri,
    QMD_GENERATE_MODEL: preflight.lock.models.generate.uri,
  };
};

export const validateQmdPreparedStatus = (
  status: Record<string, unknown>,
  snapshot: CorpusSnapshot
): void => {
  const expectedCollections = new Map<string, number>();
  for (const file of snapshot.files) {
    expectedCollections.set(
      file.collection,
      (expectedCollections.get(file.collection) ?? 0) + 1
    );
  }
  const collections = status.collections;
  const seenCollections = new Set<string>();
  const validCollections =
    Array.isArray(collections) &&
    collections.length === expectedCollections.size &&
    collections.every((collection) => {
      if (!collection || typeof collection !== "object") return false;
      const row = collection as { name?: unknown; documents?: unknown };
      const valid =
        typeof row.name === "string" &&
        Number.isSafeInteger(row.documents) &&
        expectedCollections.get(row.name) === row.documents &&
        !seenCollections.has(row.name);
      if (valid) seenCollections.add(row.name as string);
      return valid;
    });
  if (
    status.totalDocuments !== snapshot.files.length ||
    status.needsEmbedding !== 0 ||
    status.hasVectorIndex !== true ||
    !validCollections
  ) {
    throw new AgenticHarnessError(
      "qmd_index_preflight_failed",
      "Pinned qmd index status does not exactly cover the snapshot with current embeddings"
    );
  }
};

export const prepareQmdNativeIndex = async (
  snapshot: CorpusSnapshot,
  options: QmdPreflightOptions,
  services: QmdNativeServices = defaultQmdNativeServices
): Promise<QmdPreparedHandle> => {
  const started = performance.now();
  throwIfAborted(options.signal);
  const preflight = await services.preflight({
    ...options,
    commandRunner: options.commandRunner ?? services.commandRunner,
  });
  throwIfAborted(options.signal);
  const rootPath = await mkdtemp(join(tmpdir(), "gno-agentic-qmd-"));
  const corpusRoot = join(rootPath, "corpus-snapshot");
  const configDir = join(rootPath, "qmd-config");
  const xdgConfigHome = join(rootPath, "xdg-config");
  const xdgCacheHome = join(rootPath, "xdg-cache");
  const dataPath = join(rootPath, "data");
  const dbPath = join(dataPath, "index.sqlite");
  try {
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(xdgConfigHome, { recursive: true }),
      mkdir(xdgCacheHome, { recursive: true }),
      mkdir(dataPath, { recursive: true }),
    ]);
    const collections = await materializeCorpus(
      snapshot,
      corpusRoot,
      options.signal
    );
    await writeQmdConfig(
      join(configDir, "index.yml"),
      preflight,
      collections,
      options.signal
    );
    await copyPinnedModels(preflight, xdgCacheHome, options.signal);
    const env = buildQmdEnvironment(
      { configDir, xdgConfigHome, xdgCacheHome, dbPath },
      preflight
    );
    const partial = { preflight, env, rootPath };
    const version = await runPinnedQmd(
      services,
      partial,
      ["--version"],
      options.signal
    );
    const expectedVersion = `qmd ${preflight.lock.package.version} (${preflight.lock.repository.commit.slice(0, 7)})`;
    if (version !== expectedVersion) {
      throw new AgenticHarnessError(
        "qmd_runtime_version_mismatch",
        `Pinned qmd runtime version mismatch: expected ${expectedVersion}, got ${version || "<empty>"}`
      );
    }
    await runPinnedQmd(services, partial, ["update"], options.signal);
    await runPinnedQmd(services, partial, ["embed", "-f"], options.signal);

    const connection = await services.connector({
      runtimePath: process.execPath,
      entrypointPath: preflight.entrypointPath,
      cwd: rootPath,
      env,
      signal: options.signal,
    });
    try {
      await validateQmdMcpContract(connection, preflight.lock, options.signal);
      const status = await connection.callTool("status", {}, options.signal);
      if (status.isError || !status.structuredContent) {
        throw new AgenticHarnessError(
          "qmd_index_preflight_failed",
          "Pinned qmd status did not expose structured index state"
        );
      }
      validateQmdPreparedStatus(status.structuredContent, snapshot);
    } finally {
      await connection.close();
    }
    await assertQmdCheckoutStillClean(preflight, services.commandRunner);
    const indexFileSha256 = await hashQmdFile(dbPath, options.signal);
    return {
      preflight,
      rootPath,
      corpusRoot,
      configDir,
      xdgConfigHome,
      xdgCacheHome,
      dataPath,
      dbPath,
      env,
      indexFingerprint: canonicalFingerprint({
        adapter: "qmd",
        qmdLock: preflight.lockFingerprint,
        corpus: snapshot.fingerprint,
        files: snapshot.files.map(({ collection, relPath, sourceHash }) => ({
          collection,
          relPath,
          sourceHash,
        })),
      }),
      indexFileSha256,
      documentCount: snapshot.files.length,
      collectionCount: collections.size,
      preparationMs: Number((performance.now() - started).toFixed(3)),
    };
  } catch (error) {
    await services.cleanup(rootPath);
    throw error;
  }
};

export const cloneQmdPreparedRuntime = async (
  prepared: QmdPreparedHandle,
  signal?: AbortSignal
): Promise<QmdRuntimeClone> => {
  throwIfAborted(signal);
  const rootPath = await mkdtemp(join(tmpdir(), "gno-agentic-qmd-runtime-"));
  const dbPath = join(rootPath, "index.sqlite");
  try {
    await copyFileAbortable(prepared.dbPath, dbPath, signal);
    if ((await hashQmdFile(dbPath, signal)) !== prepared.indexFileSha256) {
      throw new AgenticHarnessError(
        "qmd_runtime_clone_mismatch",
        "qmd runtime database clone differs from the pristine prepared index"
      );
    }
    return {
      rootPath,
      dbPath,
      env: { ...prepared.env, INDEX_PATH: dbPath },
    };
  } catch (error) {
    await rm(rootPath, { force: true, recursive: true });
    throw error;
  }
};
