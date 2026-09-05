import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";

import type { EmbeddingPort } from "../../src/llm/types";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { ConfigSchema } from "../../src/config/types";
import { LlmAdapter } from "../../src/llm/nodeLlamaCpp/adapter";
import {
  createServerContext,
  disposeServerContext,
} from "../../src/serve/context";
import { getStoredEmbeddingDimensions } from "../../src/store/vector/freshness";
import { createLazyVectorIndex } from "../../src/store/vector/lazy";

function database(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE content_vectors (
    mirror_hash TEXT, seq INTEGER, model TEXT, embed_fingerprint TEXT,
    embedding BLOB, embedded_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (mirror_hash, seq, model))`);
  return db;
}

test("stored dimensions reject malformed and mixed model partitions", () => {
  const db = database();
  try {
    const insert = db.prepare(
      "INSERT INTO content_vectors(mirror_hash,seq,model,embedding) VALUES (?,0,'model',?)"
    );
    expect(getStoredEmbeddingDimensions(db, "model")).toBeUndefined();
    insert.run("a", new Uint8Array(12));
    expect(getStoredEmbeddingDimensions(db, "model")).toBe(3);
    insert.run("b", new Uint8Array(8));
    expect(getStoredEmbeddingDimensions(db, "model")).toBeUndefined();
    db.exec("DELETE FROM content_vectors");
    insert.run("a", new Uint8Array(7));
    expect(getStoredEmbeddingDimensions(db, "model")).toBeUndefined();
  } finally {
    db.close();
  }
});

test("empty resident vector index remains native-free until work and failed init can recover", async () => {
  const db = database();
  let loads = 0;
  let fail = true;
  const port = {
    modelUri: "model",
    init: async () => {
      loads++;
      return fail
        ? { ok: false, error: { message: "reload failed" } }
        : { ok: true, value: undefined };
    },
    dimensions: () => 3,
  } as EmbeddingPort;
  try {
    const index = await createLazyVectorIndex(db, "model", port);
    expect(index.searchAvailable).toBe(true);
    expect(loads).toBe(0);
    const failure = await index.syncVecIndex().catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("reload failed");
    fail = false;
    const recovered = await index.syncVecIndex();
    expect(recovered.ok).toBe(true);
    expect(loads).toBe(2);
    await index.syncVecIndex();
    expect(loads).toBe(2);
  } finally {
    db.close();
  }
});

test("validated stored vectors enable startup without embedding initialization", async () => {
  const db = database();
  db.prepare(
    "INSERT INTO content_vectors(mirror_hash,seq,model,embedding) VALUES ('a',0,'model',?)"
  ).run(new Uint8Array(12));
  const port = {
    init: () => {
      throw new Error("must remain lazy");
    },
  } as unknown as EmbeddingPort;
  try {
    const index = await createLazyVectorIndex(db, "model", port);
    expect(index.dimensions).toBe(3);
  } finally {
    db.close();
  }
});

test("activated variant dimensions take precedence over legacy blob metadata", () => {
  const db = database();
  try {
    db.exec(`CREATE TABLE vector_partitions (model TEXT, dimensions INTEGER, state TEXT, activated_epoch INTEGER);
      INSERT INTO vector_partitions VALUES ('model', 8, 'active', 0);`);
    db.prepare(
      "INSERT INTO content_vectors(mirror_hash,seq,model,embedding) VALUES ('a',0,'model',?)"
    ).run(new Uint8Array(12));
    expect(getStoredEmbeddingDimensions(db, "model")).toBe(8);
    db.exec("INSERT INTO vector_partitions VALUES ('model', 16, 'active', 1)");
    expect(getStoredEmbeddingDimensions(db, "model")).toBeUndefined();
  } finally {
    db.close();
  }
});

test("empty offline server context never resolves model files before first inference", async () => {
  const db = database();
  const failure = {
    ok: false as const,
    error: {
      code: "MODEL_NOT_CACHED" as const,
      message: "offline miss",
      retryable: false,
    },
  };
  const embed = spyOn(
    LlmAdapter.prototype,
    "createEmbeddingPort"
  ).mockResolvedValue(failure);
  const expand = spyOn(
    LlmAdapter.prototype,
    "createExpansionPort"
  ).mockResolvedValue(failure);
  const answer = spyOn(
    LlmAdapter.prototype,
    "createGenerationPort"
  ).mockResolvedValue(failure);
  const rerank = spyOn(
    LlmAdapter.prototype,
    "createRerankPort"
  ).mockResolvedValue(failure);
  try {
    const config = ConfigSchema.parse({
      version: "1.0",
      collections: [],
      contexts: [],
    });
    const context = await createServerContext(
      { getRawDb: () => db } as SqliteAdapter,
      config,
      { offline: true }
    );
    try {
      expect([
        embed.mock.calls.length,
        expand.mock.calls.length,
        answer.mock.calls.length,
        rerank.mock.calls.length,
      ]).toEqual([0, 0, 0, 0]);
      expect(context.capabilities.bm25).toBe(true);
      expect(await context.embedPort?.embed("first inference")).toEqual(
        failure
      );
      expect(embed).toHaveBeenCalledTimes(1);
      expect(embed.mock.calls[0]?.[1]).toMatchObject({
        policy: { offline: true, allowDownload: false },
        egressCollections: "all",
      });
    } finally {
      await disposeServerContext(context);
    }
  } finally {
    embed.mockRestore();
    expand.mockRestore();
    answer.mockRestore();
    rerank.mockRestore();
    db.close();
  }
});
