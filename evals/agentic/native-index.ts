// node:fs/promises: temporary directory lifecycle and directory creation have no Bun equivalent.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
// node:os: temporary directory discovery has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path: path construction has no Bun equivalent.
import { dirname, join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { CorpusSnapshot, NativeIndexPreparation } from "./types";

import { DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import { SyncService } from "../../src/ingestion/sync";
import { SqliteAdapter } from "../../src/store";
import { canonicalFingerprint } from "./canonical";

const materializeSnapshot = async (
  snapshot: CorpusSnapshot,
  rootPath: string
): Promise<Collection[]> => {
  const collectionRoots = new Map<string, string>();
  for (const file of snapshot.files) {
    const collectionRoot = join(rootPath, file.taskId, file.collection);
    const target = join(collectionRoot, file.relPath);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, file.content);
    collectionRoots.set(file.collection, collectionRoot);
  }
  return [...collectionRoots.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, path]) => ({
      name,
      path,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    }));
};

const mustStore = <T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
  action: string
): T => {
  if (!result.ok) throw new Error(`${action}: ${result.error.message}`);
  return result.value;
};

export const prepareGnoNativeIndex = async (
  snapshot: CorpusSnapshot
): Promise<NativeIndexPreparation> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "gno-agentic-fixture-"));
  const corpusRoot = join(tempRoot, "corpus-snapshot");
  const dbPath = join(tempRoot, "agentic.sqlite");
  const started = performance.now();
  const collections = await materializeSnapshot(snapshot, corpusRoot);
  const store = new SqliteAdapter();
  try {
    mustStore(
      await store.open(dbPath, DEFAULT_FTS_TOKENIZER),
      "open fixture index"
    );
    mustStore(
      await store.syncCollections(collections),
      "register fixture collections"
    );
    const sync = await new SyncService().syncAll(collections, store, {
      concurrency: 1,
      gitPull: false,
      runUpdateCmd: false,
    });
    if (
      sync.totalFilesErrored > 0 ||
      sync.totalFilesProcessed !== snapshot.files.length
    ) {
      throw new Error(
        `Fixture ingestion mismatch: processed=${sync.totalFilesProcessed} errors=${sync.totalFilesErrored}`
      );
    }
    const documents = mustStore(
      await store.listDocuments(),
      "read fixture documents"
    );
    const indexedSources = documents
      .filter((document) => document.active)
      .map((document) => ({
        uri: document.uri,
        sourceHash: document.sourceHash,
        mirrorHash: document.mirrorHash,
        active: document.active,
      }))
      .sort((left, right) =>
        left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0
      );
    const expectedSources = new Map(
      snapshot.files.map((file) => [
        `gno://${file.collection}/${file.relPath}`,
        file.sourceHash,
      ])
    );
    if (
      indexedSources.length !== snapshot.files.length ||
      indexedSources.some(
        (document) => expectedSources.get(document.uri) !== document.sourceHash
      )
    ) {
      throw new Error(
        "Native fixture index does not derive exactly from snapshot bytes"
      );
    }
    return {
      taskIds: Object.freeze(
        [...new Set(snapshot.files.map((file) => file.taskId))].sort()
      ),
      corpusFingerprint: snapshot.fingerprint,
      indexFingerprint: canonicalFingerprint({
        tokenizer: DEFAULT_FTS_TOKENIZER,
        documents: indexedSources,
      }),
      dbPath,
      rootPath: tempRoot,
      documentCount: indexedSources.length,
      collectionCount: collections.length,
      observations: {
        preparationMs: Number((performance.now() - started).toFixed(3)),
        filesProcessed: sync.totalFilesProcessed,
        filesErrored: sync.totalFilesErrored,
      },
    };
  } catch (error) {
    await store.close();
    await rm(tempRoot, { force: true, recursive: true });
    throw error;
  } finally {
    await store.close();
  }
};

export const cleanupNativeIndexPreparation = async (
  preparation: NativeIndexPreparation
): Promise<void> => {
  await rm(preparation.rootPath, { force: true, recursive: true });
};
