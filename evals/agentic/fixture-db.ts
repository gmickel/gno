// node:path: path construction and validation have no Bun equivalent.
import { isAbsolute, join, normalize, relative, sep } from "node:path";

import type {
  AgenticFixtureManifest,
  AdapterNativeIndexRecord,
  AgentTask,
  CorpusSnapshot,
  CorpusSnapshotFile,
  HiddenOracle,
} from "./types";

import { canonicalize } from "../../src/converters/canonicalize";
import {
  canonicalFingerprint,
  canonicalJson,
  exactLineSpan,
  sha256Bytes,
  sourceHash,
  spanHash,
} from "./canonical";
import { assertAgenticSchema } from "./validation";

export const AGENTIC_FIXTURE_ROOT = join(
  import.meta.dir,
  "../fixtures/agentic-retrieval"
);

export interface LoadedAgenticFixture {
  manifest: AgenticFixtureManifest;
  tasks: ReadonlyMap<string, AgentTask>;
  oracles: ReadonlyMap<string, HiddenOracle>;
  snapshot: CorpusSnapshot;
}

export {
  cleanupNativeIndexPreparation,
  prepareGnoNativeIndex,
} from "./native-index";

export const recordAdapterNativeIndex = (
  snapshot: CorpusSnapshot,
  record: Omit<AdapterNativeIndexRecord, "corpusFingerprint">
): AdapterNativeIndexRecord => {
  if (!record.adapterId.trim()) throw new Error("Adapter ID is required");
  if (!/^[a-f0-9]{64}$/.test(record.indexFingerprint)) {
    throw new Error("Adapter-native index fingerprint must be SHA-256");
  }
  return Object.freeze({
    ...record,
    corpusFingerprint: snapshot.fingerprint,
  });
};

const assertSafeRelativePath = (path: string): void => {
  const normalized = normalize(path);
  if (
    isAbsolute(path) ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`)
  ) {
    throw new Error(`Fixture path escapes its root: ${path}`);
  }
};

const decodeUtf8Strict = (bytes: Uint8Array, path: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`Fixture is not valid UTF-8: ${path}`, { cause });
  }
};

const manifestFingerprint = (files: readonly CorpusSnapshotFile[]): string =>
  canonicalFingerprint(
    files
      .map((file) => ({
        taskId: file.taskId,
        collection: file.collection,
        relPath: file.relPath,
        sourceHash: file.sourceHash,
      }))
      .sort((left, right) => {
        const leftKey = [
          left.taskId,
          left.collection,
          left.relPath,
          left.sourceHash,
        ].join("\0");
        const rightKey = [
          right.taskId,
          right.collection,
          right.relPath,
          right.sourceHash,
        ].join("\0");
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
  );

const coordinateSource = (
  snapshot: CorpusSnapshot,
  taskId: string,
  uri: string
): CorpusSnapshotFile => {
  const prefix = "gno://";
  if (!uri.startsWith(prefix)) throw new Error(`Invalid evidence URI: ${uri}`);
  const slash = uri.indexOf("/", prefix.length);
  if (slash < 0) throw new Error(`Invalid evidence URI: ${uri}`);
  const collection = uri.slice(prefix.length, slash);
  const relPath = uri.slice(slash + 1);
  const source = snapshot.files.find(
    (file) =>
      file.taskId === taskId &&
      file.collection === collection &&
      file.relPath === relPath
  );
  if (!source) throw new Error(`Evidence source is not in task corpus: ${uri}`);
  return source;
};

const verifyOracleEvidence = (
  oracle: HiddenOracle,
  snapshot: CorpusSnapshot
): void => {
  for (const claim of oracle.claims) {
    for (const coordinate of [
      ...claim.requiredEvidence,
      ...claim.optionalEvidence,
      ...claim.forbiddenEvidence,
    ]) {
      if (coordinate.endLine < coordinate.startLine) {
        throw new Error(
          `Evidence line range is reversed for ${coordinate.uri}`
        );
      }
      const source = coordinateSource(snapshot, oracle.taskId, coordinate.uri);
      const content = source.content;
      if (coordinate.sourceHash !== sourceHash(content)) {
        throw new Error(`Evidence source hash mismatch for ${coordinate.uri}`);
      }
      exactLineSpan(content, coordinate.startLine, coordinate.endLine);
      if (
        coordinate.spanHash !==
        spanHash(content, coordinate.startLine, coordinate.endLine)
      ) {
        throw new Error(`Evidence span hash mismatch for ${coordinate.uri}`);
      }
    }
  }
};

const assertLeakResistance = (
  tasks: ReadonlyMap<string, AgentTask>,
  oracles: ReadonlyMap<string, HiddenOracle>,
  snapshot: CorpusSnapshot
): void => {
  const allCanaries = [...oracles.values()].flatMap(
    (oracle) => oracle.leakCanaries
  );
  for (const taskId of oracles.keys()) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Oracle has no public task: ${taskId}`);
    const visible = [
      `${taskId}.json`,
      canonicalJson(task),
      ...snapshot.files
        .filter((file) => file.taskId === taskId)
        .flatMap((file) => [
          relative(AGENTIC_FIXTURE_ROOT, file.sourcePath),
          file.content,
        ]),
    ].join("\n");
    for (const canary of allCanaries) {
      if (visible.includes(canary)) {
        throw new Error(
          `Hidden oracle canary leaked into agent-visible data: ${taskId}`
        );
      }
    }
  }
};

const assertProductionStableCorpus = (file: CorpusSnapshotFile): void => {
  const content = file.content;
  if (canonicalize(content) !== content) {
    throw new Error(
      `Fixture corpus is not stable under production Markdown canonicalization: ${file.sourcePath}`
    );
  }
};

const verifyTaskOracleContract = (
  task: AgentTask,
  oracle: HiddenOracle
): void => {
  const definitions = new Map<string, AgentTask["claims"][number]>();
  for (const definition of task.claims) {
    if (definitions.has(definition.claimKey)) {
      throw new Error(`Duplicate public claim key: ${task.taskId}`);
    }
    definitions.set(definition.claimKey, definition);
  }
  const oracleKeys = new Set<string>();
  for (const claim of oracle.claims) {
    const definition = definitions.get(claim.claimKey);
    if (!definition) {
      throw new Error(
        `Oracle claim is not public: ${task.taskId}/${claim.claimKey}`
      );
    }
    if (oracleKeys.has(claim.claimKey)) {
      throw new Error(
        `Duplicate oracle claim key: ${task.taskId}/${claim.claimKey}`
      );
    }
    oracleKeys.add(claim.claimKey);
    if (claim.expectedValue.type !== definition.valueType) {
      throw new Error(
        `Oracle claim type mismatch: ${task.taskId}/${claim.claimKey}`
      );
    }
    const expectedNormalizer =
      definition.valueType === "identifier"
        ? "identifier-v1"
        : definition.valueType === "date"
          ? "iso-date-v1"
          : definition.valueType === "string[]"
            ? "string-set-v1"
            : "exact-v1";
    const stringNormalizerAllowed =
      definition.valueType === "string" &&
      claim.normalizer.id === "trim-lower-v1";
    if (
      claim.normalizer.id !== expectedNormalizer &&
      !stringNormalizerAllowed
    ) {
      throw new Error(
        `Oracle normalizer mismatch: ${task.taskId}/${claim.claimKey}`
      );
    }
  }
  for (const claimKey of oracle.expectedMissing) {
    if (!definitions.has(claimKey) || oracleKeys.has(claimKey)) {
      throw new Error(
        `Invalid expected-missing claim: ${task.taskId}/${claimKey}`
      );
    }
  }
  for (const definition of definitions.values()) {
    if (
      definition.required &&
      !oracleKeys.has(definition.claimKey) &&
      !oracle.expectedMissing.includes(definition.claimKey)
    ) {
      throw new Error(
        `Required claim has no oracle outcome: ${task.taskId}/${definition.claimKey}`
      );
    }
  }
  if (
    oracle.expectedScope.collection !== null &&
    !task.corpus.collections.includes(oracle.expectedScope.collection)
  ) {
    throw new Error(
      `Oracle collection is not in public task corpus: ${task.taskId}`
    );
  }
  if (
    task.budgets.maxAgentCalls !== oracle.completion.maxAgentCalls ||
    task.budgets.maxModelVisibleBytes !== oracle.completion.maxModelVisibleBytes
  ) {
    throw new Error(
      `Public and hidden completion budgets differ: ${task.taskId}`
    );
  }
};

export const loadAgenticFixture = async (
  root = AGENTIC_FIXTURE_ROOT
): Promise<LoadedAgenticFixture> => {
  const manifestPath = join(root, "manifest.json");
  const manifest = (await Bun.file(
    manifestPath
  ).json()) as AgenticFixtureManifest;
  if (
    manifest.schemaVersion !== "1.0" ||
    !Array.isArray(manifest.files) ||
    typeof manifest.corpusFingerprint !== "string"
  ) {
    throw new Error("Invalid agentic fixture manifest");
  }
  const tasks = new Map<string, AgentTask>();
  const oracles = new Map<string, HiddenOracle>();
  const corpusFiles: CorpusSnapshotFile[] = [];
  const seenPaths = new Set<string>();
  const collectionOwners = new Map<string, string>();
  const taskEntryCount = manifest.files.filter(
    (entry) => entry.kind === "task"
  ).length;
  const oracleEntryCount = manifest.files.filter(
    (entry) => entry.kind === "oracle"
  ).length;
  if (
    taskEntryCount !== manifest.taskCount ||
    oracleEntryCount !== manifest.taskCount
  ) {
    throw new Error("Fixture manifest task/oracle entry count mismatch");
  }
  for (const entry of manifest.files) {
    assertSafeRelativePath(entry.path);
    if (seenPaths.has(entry.path)) {
      throw new Error(`Duplicate fixture manifest path: ${entry.path}`);
    }
    seenPaths.add(entry.path);
    const absolutePath = join(root, entry.path);
    const bytes = await Bun.file(absolutePath).bytes();
    const actualHash = sha256Bytes(bytes);
    if (actualHash !== entry.sha256) {
      throw new Error(`Fixture manifest hash mismatch: ${entry.path}`);
    }
    if (entry.kind === "task") {
      const task = JSON.parse(decodeUtf8Strict(bytes, entry.path)) as unknown;
      assertAgenticSchema("agent-task", task);
      if (task.taskId !== entry.taskId) {
        throw new Error(`Task manifest identity mismatch: ${entry.path}`);
      }
      if (tasks.has(task.taskId)) {
        throw new Error(`Duplicate task manifest identity: ${task.taskId}`);
      }
      tasks.set(task.taskId, task);
    } else if (entry.kind === "oracle") {
      const oracle = JSON.parse(decodeUtf8Strict(bytes, entry.path)) as unknown;
      assertAgenticSchema("hidden-oracle", oracle);
      if (oracle.taskId !== entry.taskId) {
        throw new Error(`Oracle manifest identity mismatch: ${entry.path}`);
      }
      if (oracles.has(oracle.taskId)) {
        throw new Error(`Duplicate oracle manifest identity: ${oracle.taskId}`);
      }
      oracles.set(oracle.taskId, oracle);
    } else {
      if (!entry.collection) {
        throw new Error(`Corpus entry lacks collection: ${entry.path}`);
      }
      const existingOwner = collectionOwners.get(entry.collection);
      if (existingOwner && existingOwner !== entry.taskId) {
        throw new Error(
          `Fixture collection ${entry.collection} belongs to multiple tasks`
        );
      }
      collectionOwners.set(entry.collection, entry.taskId);
      const prefix = `corpus/${entry.taskId}/${entry.collection}/`;
      if (!entry.path.startsWith(prefix)) {
        throw new Error(
          `Corpus entry path does not match manifest scope: ${entry.path}`
        );
      }
      const file: CorpusSnapshotFile = Object.freeze({
        taskId: entry.taskId,
        collection: entry.collection,
        relPath: entry.path.slice(prefix.length),
        sourcePath: absolutePath,
        sourceHash: actualHash,
        content: decodeUtf8Strict(bytes, entry.path),
      });
      assertProductionStableCorpus(file);
      corpusFiles.push(file);
    }
  }
  if (
    tasks.size !== manifest.taskCount ||
    oracles.size !== manifest.taskCount
  ) {
    throw new Error(
      `Fixture task/oracle count mismatch: manifest=${manifest.taskCount} tasks=${tasks.size} oracles=${oracles.size}`
    );
  }
  const snapshot: CorpusSnapshot = Object.freeze({
    fixtureVersion: manifest.fixtureVersion,
    fingerprint: manifestFingerprint(corpusFiles),
    files: Object.freeze(
      [...corpusFiles].sort((left, right) =>
        left.sourcePath < right.sourcePath
          ? -1
          : left.sourcePath > right.sourcePath
            ? 1
            : 0
      )
    ),
  });
  if (snapshot.fingerprint !== manifest.corpusFingerprint) {
    throw new Error("Fixture corpus fingerprint mismatch");
  }
  for (const taskId of tasks.keys()) {
    if (!oracles.has(taskId)) throw new Error(`Task has no oracle: ${taskId}`);
    const task = tasks.get(taskId);
    const oracle = oracles.get(taskId);
    if (!task || !oracle)
      throw new Error(`Fixture pair disappeared: ${taskId}`);
    verifyTaskOracleContract(task, oracle);
    const actualCollections = new Set(
      snapshot.files
        .filter((file) => file.taskId === taskId)
        .map((file) => file.collection)
    );
    if (
      task.corpus.collections.some(
        (collection) => !actualCollections.has(collection)
      ) ||
      [...actualCollections].some(
        (collection) => !task.corpus.collections.includes(collection)
      )
    ) {
      throw new Error(`Public task corpus inventory mismatch: ${taskId}`);
    }
  }
  for (const oracle of oracles.values()) verifyOracleEvidence(oracle, snapshot);
  assertLeakResistance(tasks, oracles, snapshot);
  return {
    manifest: Object.freeze(manifest),
    tasks,
    oracles,
    snapshot,
  };
};
