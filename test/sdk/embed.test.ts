import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { LlmAdapter } from "../../src/llm/nodeLlamaCpp/adapter";
import type { EmbeddingPort } from "../../src/llm/types";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { CONFIG_VERSION } from "../../src/config/types";
import { getEmbeddingFingerprint } from "../../src/embed/fingerprint";
import { runEmbed } from "../../src/sdk/embed";
import { migration } from "../../src/store/migrations/028-vector-variants";
import { encodeEmbedding } from "../../src/store/vector";
import { safeRm } from "../helpers/cleanup";

const MODEL_URI = "hf:test/model.gguf";

describe("runEmbed", () => {
  let db: Database | undefined;
  let testDir: string | undefined;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (testDir) {
      await safeRm(testDir);
      testDir = undefined;
    }
  });

  test.each([false, true])(
    "dry-run backlog uses actual model dimensions (verified=%s)",
    async (verified) => {
      testDir = await mkdtemp(join(tmpdir(), "gno-sdk-embed-test-"));
      db = new Database(join(testDir, "index.sqlite"), { create: true });
      db.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY,
        mirror_hash TEXT,
        title TEXT,
        collection TEXT,
        active INTEGER DEFAULT 1
      );

      CREATE TABLE content_chunks (
        mirror_hash TEXT NOT NULL,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (mirror_hash, seq)
      );

      CREATE TABLE content_vectors (
        mirror_hash TEXT NOT NULL,
        seq INTEGER NOT NULL,
        model TEXT NOT NULL,
        embed_fingerprint TEXT NOT NULL DEFAULT '',
        embedding BLOB NOT NULL,
        embedded_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (mirror_hash, seq, model)
      );
    `);

      migration.up(db, "unicode61");

      const staleStoredFingerprint = getEmbeddingFingerprint({
        modelUri: MODEL_URI,
        dimensions: 2,
      });

      db.prepare(
        "INSERT INTO documents (id, mirror_hash, active) VALUES (1, 'h1', 1)"
      ).run();
      db.prepare(
        "INSERT INTO content_chunks (mirror_hash, seq, text, created_at) VALUES ('h1', 0, 'chunk', datetime('now', '-1 minute'))"
      ).run();
      db.prepare(
        `INSERT INTO content_vectors (
        mirror_hash, seq, model, embed_fingerprint, embedding, embedded_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now'))`
      ).run(
        "h1",
        0,
        MODEL_URI,
        staleStoredFingerprint,
        encodeEmbedding(new Float32Array([1, 2]))
      );

      const embedPort: EmbeddingPort = {
        modelUri: MODEL_URI,
        init: async () => ({ ok: true, value: undefined }),
        embed: async () => ({ ok: true, value: [1, 2, 3] }),
        embedBatch: async () => ({ ok: true, value: [[1, 2, 3]] }),
        dimensions: () => 3,
        dispose: async () => {},
      };
      if (verified)
        embedPort.getIdentity = () => ({
          contextSize: 512,
          truncationPolicy: "test",
          modelFingerprint: "weights",
          runtimeFingerprint: "runtime",
        });
      const llm = {
        createEmbeddingPort: async () => ({ ok: true, value: embedPort }),
      } as unknown as LlmAdapter;
      const store = {
        getRawDb: () => db as Database,
      } as unknown as SqliteAdapter;
      const config: Config = {
        version: CONFIG_VERSION,
        ftsTokenizer: "unicode61",
        collections: [],
        contexts: [],
      };

      const result = await runEmbed(
        { config, store, llm },
        { model: MODEL_URI, dryRun: true }
      );

      expect(result.embedded).toBe(1);
      if (verified) {
        expect(
          (await runEmbed({ config, store, llm }, { model: MODEL_URI }))
            .embedded
        ).toBe(1);
        expect(
          (
            await runEmbed(
              { config, store, llm },
              { model: MODEL_URI, dryRun: true }
            )
          ).embedded
        ).toBe(0);
        expect(
          (
            await runEmbed(
              { config, store, llm },
              { model: MODEL_URI, dryRun: true, force: true }
            )
          ).embedded
        ).toBe(1);
        expect(
          (
            await runEmbed(
              { config, store, llm },
              { model: MODEL_URI, force: true }
            )
          ).embedded
        ).toBe(1);
        embedPort.getIdentity = () => undefined;
        expect(
          runEmbed(
            { config, store, llm },
            { model: MODEL_URI, force: true, dryRun: true }
          )
        ).rejects.toThrow("identity unavailable");
      }
    }
  );
});
