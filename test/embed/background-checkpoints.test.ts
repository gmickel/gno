import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import type { EmbeddingPort } from "../../src/llm/types";

import { embedBacklog } from "../../src/embed/backlog";
import { embedAndStoreBatch } from "../../src/embed/retry";
import { withBackgroundInference } from "../../src/llm/inference-scope";
import { createLazyVectorIndex } from "../../src/store/vector/lazy";
import { createVectorIndexPort } from "../../src/store/vector/sqlite-vec";
import { createVectorStatsPort } from "../../src/store/vector/stats";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE documents(id INTEGER PRIMARY KEY, mirror_hash TEXT, title TEXT, active INTEGER, collection TEXT);
    CREATE TABLE content_chunks(mirror_hash TEXT, seq INTEGER, text TEXT, created_at TEXT);
    CREATE TABLE content_vectors(mirror_hash TEXT, seq INTEGER, model TEXT, embed_fingerprint TEXT, embedding BLOB, embedded_at TEXT,
      PRIMARY KEY(mirror_hash,seq,model));
    INSERT INTO documents VALUES(1,'body','Alpha',1,'docs');
    INSERT INTO content_chunks VALUES('body',0,'Original body','2020-01-01');`);
  const inputs: string[] = [];
  const port: EmbeddingPort = {
    modelUri: "test-model",
    dimensions: () => 3,
    init: async () => ({ ok: true, value: undefined }),
    embed: async () => ({ ok: true, value: [1, 2, 3] }),
    embedBatch: async (texts) => {
      inputs.push(...texts);
      return { ok: true, value: texts.map(() => [1, 2, 3]) };
    },
    dispose: async () => {},
  };
  return { db, port, inputs, statsPort: createVectorStatsPort(db) };
}

test.each(["title", "content", "delete", "model"])(
  "legacy %s mutation during lazy checkpoint initialization prevents stale vectors",
  async (mutation) => {
    const { db, port, inputs, statsPort } = fixture();
    let current = true;
    const index = await createLazyVectorIndex(db, port.modelUri, port);
    // Inference has completed before lazy index initialization awaits this port.
    port.init = async () => {
      if (mutation === "title") db.run("UPDATE documents SET title='Beta'");
      if (mutation === "content")
        db.run("UPDATE content_chunks SET text='Changed body'");
      if (mutation === "delete") db.run("UPDATE documents SET active=0");
      if (mutation === "model") current = false;
      return { ok: true, value: undefined };
    };
    const result = await embedAndStoreBatch({
      embedPort: port,
      vectorIndex: index,
      statsPort,
      modelUri: port.modelUri,
      embedFingerprint: "fixture",
      identityStillCurrent: () => current,
      items: [
        {
          mirrorHash: "body",
          seq: 0,
          text: "Original body",
          title: "Alpha",
          reason: "new",
        },
      ],
    });
    expect(result.embedded).toBe(0);
    expect(result.retryItems).toHaveLength(1);
    expect(db.query("SELECT * FROM content_vectors").all()).toEqual([]);
    expect(inputs).toEqual(["title: Alpha | text: Original body"]);
    if (mutation === "title" || mutation === "content") {
      port.init = async () => ({ ok: true, value: undefined });
      expect(
        await withBackgroundInference(() =>
          embedBacklog({
            statsPort,
            embedPort: port,
            vectorIndex: index,
            modelUri: port.modelUri,
          })
        )
      ).toMatchObject({ ok: true, value: { embedded: 1, errors: 0 } });
      expect(
        await withBackgroundInference(() =>
          embedBacklog({
            statsPort,
            embedPort: port,
            vectorIndex: index,
            modelUri: port.modelUri,
          })
        )
      ).toMatchObject({ ok: true, value: { embedded: 0 } });
      expect(inputs).toHaveLength(2);
    }
  }
);

test("DB-backed custom ports without atomic checkpoints fail closed before inference", async () => {
  const { db, port, inputs, statsPort } = fixture();
  const result = await createVectorIndexPort(db, {
    model: port.modelUri,
    dimensions: 3,
  });
  if (!result.ok) throw new Error(result.error.message);
  result.value.upsertVectorsChecked = undefined;
  expect(
    await embedBacklog({
      statsPort,
      embedPort: port,
      vectorIndex: result.value,
      modelUri: port.modelUri,
    })
  ).toMatchObject({ ok: true, value: { embedded: 0, errors: 1 } });
  expect(inputs).toEqual([]);
  expect(db.query("SELECT * FROM content_vectors").all()).toEqual([]);
});

test("checked checkpoint revalidates after contention and never reports rolled-back writes", async () => {
  const { db, port, statsPort } = fixture();
  const index = await createVectorIndexPort(db, {
    model: port.modelUri,
    dimensions: 3,
  });
  if (!index.ok) throw new Error(index.error.message);
  const checked = index.value.upsertVectorsChecked!.bind(index.value);
  let attempts = 0;
  index.value.upsertVectorsChecked = async (rows, validate) => {
    if (attempts++ === 0) {
      db.run("UPDATE documents SET title='Beta'");
      return {
        ok: false,
        error: {
          code: "QUERY_FAILED",
          message: "SQLITE_BUSY",
          cause: { code: "SQLITE_BUSY" },
        },
      };
    }
    return checked(rows, validate);
  };
  const params = {
    embedPort: port,
    vectorIndex: index.value,
    statsPort,
    modelUri: port.modelUri,
    embedFingerprint: "fixture",
    items: [
      {
        mirrorHash: "body",
        seq: 0,
        text: "Original body",
        title: "Alpha",
        reason: "new" as const,
      },
    ],
    delays: [0],
  };
  expect(await embedAndStoreBatch(params)).toMatchObject({
    embedded: 0,
    errors: 0,
  });
  expect(attempts).toBe(2);
  db.exec(
    "CREATE TRIGGER fail_vector BEFORE INSERT ON content_vectors BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END"
  );
  expect(
    await embedAndStoreBatch({
      ...params,
      items: [{ ...params.items[0]!, title: "Beta" }],
    })
  ).toMatchObject({ embedded: 0, errors: 1 });
  expect(db.query("SELECT * FROM content_vectors").all()).toEqual([]);
});
