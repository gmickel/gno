/**
 * Shared harness for request-receipt fault tests: one temp index with a
 * memory collection and a notes collection, the four scoped mutations driven
 * through their real shared services, and read-back of durable side effects.
 * Used in-process and by the separate-process crash fixture.
 */

// node:fs/promises mkdir/readdir/stat: structure ops, no Bun equivalent
import { mkdir, readdir, stat } from "node:fs/promises";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Collection, Config } from "../../src/config/types";
import type { RequestCheckpoint } from "../../src/core/request-receipts";

import { createDefaultConfig } from "../../src/config/defaults";
import { listCaptureDiskRelPaths, planCapture } from "../../src/core/capture";
import { publishCapture } from "../../src/core/capture-publish";
import { MemoryService } from "../../src/core/memory";
import {
  LOCAL_OWNER_NAMESPACE,
  requestLedgerPath,
} from "../../src/core/request-receipts";
import { defaultSyncService } from "../../src/ingestion";
import { handleUpdateDoc } from "../../src/serve/routes/api";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";

export const SCOPED_OPS = [
  "remember-add",
  "remember-supersede",
  "capture",
  "document-update",
] as const;
export type ScopedOp = (typeof SCOPED_OPS)[number];

export interface ReceiptHarness {
  root: string;
  store: SqliteAdapter;
  config: Config;
  memory: Collection;
  notes: Collection;
  lockPath: string;
  ledgerPath: string;
}

export interface OpSeed {
  predecessorUri?: string;
  predecessorHash?: string;
  docid?: string;
  docUri?: string;
  sourceHash?: string;
}

export interface OpOutcome {
  ok: boolean;
  /** Stable identity of what the request produced (uri or new hash). */
  ref?: string;
  replayed?: boolean;
  status?: number;
  code?: string;
}

const DOC_REL_PATH = "doc.md";
const CAPTURE_FOLDER = "inbox";

/** `registerCollections: false` reuses an index another process registered. */
export async function openReceiptHarness(
  root: string,
  options: { registerCollections?: boolean } = {}
): Promise<ReceiptHarness> {
  await mkdir(join(root, "memory"), { recursive: true });
  await mkdir(join(root, "notes"), { recursive: true });
  const memory: Collection = {
    name: "memory",
    path: join(root, "memory"),
    pattern: "**/*.md",
    include: [],
    exclude: [],
    memoryManaged: true,
  };
  const notes: Collection = {
    name: "notes",
    path: join(root, "notes"),
    pattern: "**/*.{md,txt}",
    include: [],
    exclude: [],
  };
  const config = { ...createDefaultConfig(), collections: [memory, notes] };
  const store = new SqliteAdapter();
  const dbPath = join(root, "index.sqlite");
  const opened = await store.open(dbPath, config.ftsTokenizer);
  if (!opened.ok) throw new Error(opened.error.message);
  if (options.registerCollections !== false) {
    const synced = await store.syncCollections(config.collections);
    if (!synced.ok) throw new Error(synced.error.message);
  }
  return {
    root,
    store,
    config,
    memory,
    notes,
    lockPath: join(root, ".mcp-write.lock"),
    ledgerPath: requestLedgerPath(dbPath),
  };
}

function memoryService(
  h: ReceiptHarness,
  checkpoint?: (stage: RequestCheckpoint) => Promise<void> | void
): MemoryService {
  return new MemoryService({
    store: h.store,
    config: h.config,
    collections: h.config.collections,
    lockPath: h.lockPath,
    lockWaitMs: 20_000,
    requests: {
      ledgerPath: h.ledgerPath,
      namespace: LOCAL_OWNER_NAMESPACE,
      checkpoint,
    },
  });
}

/** Prepare the pre-existing state an operation needs (no request ID). */
export async function seedOp(h: ReceiptHarness, op: ScopedOp): Promise<OpSeed> {
  if (op === "remember-supersede") {
    const added = await memoryService(h).remember({
      caller: "seed",
      session: "seed",
      text: "The office is in Zurich",
      collection: "memory",
      scopes: ["project:receipts"],
      decision: "add",
    });
    if (added.outcome !== "added") throw new Error("seed remember failed");
    return {
      predecessorUri: added.record.uri,
      predecessorHash: added.record.contentHash,
    };
  }
  if (op === "document-update") {
    await Bun.write(join(h.notes.path, DOC_REL_PATH), "# Doc\n\nv0\n");
    await defaultSyncService.syncCollection(h.notes, h.store, {
      runUpdateCmd: false,
      gitPull: false,
    });
    const doc = await h.store.getDocument("notes", DOC_REL_PATH);
    if (!doc.ok || !doc.value) throw new Error("seed document failed");
    return {
      docid: doc.value.docid,
      docUri: doc.value.uri,
      sourceHash: doc.value.sourceHash,
    };
  }
  return {};
}

const errorCode = (error: unknown): string =>
  error && typeof error === "object" && "code" in error
    ? String(error.code)
    : error instanceof Error
      ? error.message
      : String(error);

/**
 * Run one scoped mutation with a request ID. `variant` changes the payload
 * (same ID, different intent); `session` changes only transport identity.
 */
export async function runOp(
  h: ReceiptHarness,
  op: ScopedOp,
  options: {
    requestId: string;
    seed: OpSeed;
    variant?: string;
    session?: string;
    checkpoint?: (stage: RequestCheckpoint) => Promise<void> | void;
  }
): Promise<OpOutcome> {
  const suffix = options.variant ? ` (${options.variant})` : "";
  try {
    if (op === "remember-add" || op === "remember-supersede") {
      const result = await memoryService(h, options.checkpoint).remember({
        caller: "agent",
        session: options.session ?? "session-1",
        text:
          op === "remember-add"
            ? `Gordon prefers Bun${suffix}`
            : `The office is in Basel${suffix}`,
        collection: "memory",
        scopes: ["project:receipts"],
        decision: op === "remember-add" ? "add" : "supersede",
        predecessorUri: options.seed.predecessorUri,
        predecessorHash: options.seed.predecessorHash,
        requestId: options.requestId,
      });
      if (result.outcome === "candidates") throw new Error("no write");
      return {
        ok: true,
        ref: result.record.uri,
        replayed: result.request?.replayed,
      };
    }
    if (op === "capture") {
      const input = {
        collection: "notes",
        title: "Retry Capture",
        folderPath: CAPTURE_FOLDER,
        content: `Captured once${suffix}`,
        collisionPolicy: "create_with_suffix" as const,
      };
      const published = await publishCapture({
        collection: h.notes,
        store: h.store,
        lockPath: h.lockPath,
        lockWaitMs: 20_000,
        config: h.config,
        plan: async () => {
          const docs = await h.store.listDocuments("notes");
          if (!docs.ok) throw new Error(docs.error.message);
          return planCapture({
            input,
            existingRelPaths: docs.value.map((doc) => doc.relPath),
            diskRelPaths: await listCaptureDiskRelPaths(h.notes.path),
          });
        },
        request: {
          ledgerPath: h.ledgerPath,
          namespace: LOCAL_OWNER_NAMESPACE,
          requestId: options.requestId,
          input,
          checkpoint: options.checkpoint,
        },
      });
      return {
        ok: true,
        ref: published.receipt.uri,
        replayed: published.request?.replayed,
      };
    }
    const response = await handleUpdateDoc(
      {
        current: {},
        config: h.config,
        scheduler: null,
        eventBus: null,
        watchService: null,
      } as never,
      h.store,
      options.seed.docid ?? "",
      new Request("http://localhost/api/docs/doc", {
        method: "PUT",
        body: JSON.stringify({
          uri: options.seed.docUri,
          content: `# Doc\n\nv1${suffix}\n`,
          expectedSourceHash: options.seed.sourceHash,
          requestId: options.requestId,
        }),
      }),
      {
        lockPath: h.lockPath,
        lockWaitMs: 20_000,
        requestCheckpoint: options.checkpoint,
        syncCollection: async () => {
          throw new Error("deferred sync is not exercised here");
        },
      }
    );
    const body = (await response.json()) as {
      version?: { sourceHash: string };
      request?: { replayed: boolean };
      error?: { code: string };
    };
    return response.ok
      ? {
          ok: true,
          ref: body.version?.sourceHash,
          replayed: body.request?.replayed,
          status: response.status,
        }
      : { ok: false, code: body.error?.code, status: response.status };
  } catch (error) {
    return { ok: false, code: errorCode(error) };
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  if (!(await stat(dir).catch(() => null))) return files;
  for (const entry of await readdir(dir, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(join(entry.parentPath, entry.name));
    }
  }
  return files;
}

/** The file a request of `op` publishes (after at most one such write). */
export async function publishedFile(
  h: ReceiptHarness,
  op: ScopedOp,
  seed: OpSeed
): Promise<string> {
  if (op === "document-update") return join(h.notes.path, DOC_REL_PATH);
  const dir =
    op === "capture" ? join(h.notes.path, CAPTURE_FOLDER) : h.memory.path;
  const predecessor = seed.predecessorUri?.replace("gno://memory/", "");
  const written = (await listFiles(dir)).filter(
    (path) => !predecessor || !path.endsWith(predecessor)
  );
  if (written.length !== 1) throw new Error(`expected one published file`);
  return written[0] as string;
}

/**
 * Durable side effects of `op` read back from disk: record/capture files
 * written by the request, or for a document update, whether the new content
 * landed plus the file identity (a rewrite replaces the inode).
 */
export async function readSideEffects(
  h: ReceiptHarness,
  op: ScopedOp
): Promise<{ writes: number; fileId?: string }> {
  if (op === "remember-add") {
    return { writes: (await listFiles(h.memory.path)).length };
  }
  if (op === "remember-supersede") {
    return { writes: (await listFiles(h.memory.path)).length - 1 };
  }
  if (op === "capture") {
    return {
      writes: (await listFiles(join(h.notes.path, CAPTURE_FOLDER))).length,
    };
  }
  const path = join(h.notes.path, DOC_REL_PATH);
  const content = await Bun.file(path).text();
  const info = await stat(path);
  return {
    writes: content.startsWith("# Doc\n\nv1") ? 1 : 0,
    fileId: `${info.ino}:${info.mtimeMs}`,
  };
}
