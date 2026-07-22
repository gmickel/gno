import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StorePort } from "../../src/store/types";

import {
  extractActivationProbeTerms,
  verifyLexicalActivation,
} from "../../src/core/activation-verifier";
import { SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

const FIXED_NOW = new Date("2026-07-22T10:00:00.000Z");

function hash(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

describe("lexical activation verifier", () => {
  let adapter: SqliteAdapter;
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-activation-test-"));
    dbPath = join(testDir, "index-test.sqlite");
    adapter = new SqliteAdapter();
    const opened = await adapter.open(dbPath, "unicode61");
    expect(opened.ok).toBe(true);
    const synced = await adapter.syncCollections([
      {
        name: "notes",
        path: "/notes",
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ]);
    expect(synced.ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  async function addDocument(
    relPath: string,
    markdown: string,
    syncFts = true
  ): Promise<void> {
    const sourceHash = hash(`source:${relPath}:${markdown}`);
    const mirrorHash = hash(`mirror:${markdown}`);
    const upserted = await adapter.upsertDocument({
      collection: "notes",
      relPath,
      sourceHash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: markdown.length,
      sourceMtime: "2026-07-22T09:00:00.000Z",
      mirrorHash,
      title: relPath,
    });
    expect(upserted.ok).toBe(true);
    expect((await adapter.upsertContent(mirrorHash, markdown)).ok).toBe(true);
    expect(
      (
        await adapter.upsertChunks(mirrorHash, [
          {
            seq: 0,
            pos: 0,
            text: markdown,
            startLine: 1,
            endLine: markdown.split("\n").length,
          },
        ])
      ).ok
    ).toBe(true);
    if (syncFts) {
      expect((await adapter.syncDocumentFts("notes", relPath)).ok).toBe(true);
    }
  }

  const verifierOptions = {
    now: () => FIXED_NOW,
    monotonicNow: () => 10,
  };

  test("proves a fresh corpus lexically without loading semantic models", async () => {
    await addDocument(
      "architecture.md",
      "# Architecture\nZephyrlattice documents the offline retrieval boundary."
    );

    const result = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.ready).toBe(true);
    expect(result.value.stages.index.status).toBe("passed");
    expect(result.value.stages.lexical.status).toBe("passed");
    expect(result.value.stages.semantic).toMatchObject({
      status: "pending",
      code: "semantic_not_checked",
    });
    expect(result.value.evidence.resultUri).toBe("gno://notes/architecture.md");
    expect(result.value.evidence.probeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("fails explicitly for an empty collection", async () => {
    const result = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.ready).toBe(false);
    expect(result.value.stages.index).toMatchObject({
      status: "failed",
      code: "no_documents",
    });
  });

  test("fails with no_probe_term for stopword-only and numeric text", async () => {
    await addDocument("empty-terms.md", "the and of to 12345");

    const result = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.ready).toBe(false);
    expect(result.value.stages.lexical).toMatchObject({
      status: "failed",
      code: "no_probe_term",
    });
  });

  test("extracts and retrieves a non-Latin Unicode probe", async () => {
    await addDocument("tokyo.md", "東京計画 進捗確認 チーム共有");

    expect(extractActivationProbeTerms("東京計画 進捗確認")).toEqual([
      "東京計画",
      "進捗確認",
    ]);
    const result = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.ready).toBe(true);
    expect(result.value.stages.lexical.status).toBe("passed");
  });

  test("preserves full-width Unicode terms used by unicode61", async () => {
    await addDocument("full-width.md", "Ｚｅｐｈｙｒ 検証 証拠");

    expect(extractActivationProbeTerms("Ｚｅｐｈｙｒ 検証")).toEqual([
      "ｚｅｐｈｙｒ",
      "検証",
    ]);
    const result = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ready).toBe(true);
    }
  });

  test("does not create an invalid two-codepoint trigram probe", async () => {
    expect(extractActivationProbeTerms("東京", "trigram")).toEqual([]);

    await adapter.close();
    dbPath = join(testDir, "trigram-test.sqlite");
    adapter = new SqliteAdapter();
    expect((await adapter.open(dbPath, "trigram")).ok).toBe(true);
    expect(
      (
        await adapter.syncCollections([
          {
            name: "notes",
            path: "/notes",
            pattern: "**/*",
            include: [],
            exclude: [],
          },
        ])
      ).ok
    ).toBe(true);
    await addDocument("short-cjk.md", "東京");

    const result = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stages.lexical).toMatchObject({
        status: "failed",
        code: "no_probe_term",
      });
    }
  });

  test("fails closed when lexical results do not match the expected source", async () => {
    await addDocument("expected.md", "uniquefailureprobe evidence");
    const mismatchingStore = new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === "searchFts") {
          return async () => ({
            ok: true as const,
            value: [
              {
                mirrorHash: hash("wrong-mirror"),
                seq: 0,
                score: -1,
                uri: "gno://notes/wrong.md",
                sourceHash: hash("wrong-source"),
              },
            ],
          });
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StorePort;

    const result = await verifyLexicalActivation(mismatchingStore, "notes", {
      ...verifierOptions,
      force: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.ready).toBe(false);
    expect(result.value.stages.lexical).toMatchObject({
      status: "failed",
      code: "retrieval_mismatch",
    });
  });

  test("retries a transient index query failure under the same fingerprint", async () => {
    await addDocument("retry-query.md", "transientqueryneedle evidence");
    let searches = 0;
    const retryingStore = new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === "searchFts") {
          return async (...args: Parameters<StorePort["searchFts"]>) => {
            searches += 1;
            if (searches === 1) {
              return {
                ok: false as const,
                error: {
                  code: "QUERY_FAILED" as const,
                  message: "transient test failure",
                },
              };
            }
            return target.searchFts(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StorePort;

    const failed = await verifyLexicalActivation(
      retryingStore,
      "notes",
      verifierOptions
    );
    expect(failed.ok).toBe(true);
    if (!failed.ok) {
      return;
    }
    expect(failed.value.stages.lexical.code).toBe("index_query_failed");

    const recovered = await verifyLexicalActivation(
      retryingStore,
      "notes",
      verifierOptions
    );
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value.ready).toBe(true);
      expect(recovered.value.fingerprint).toBe(failed.value.fingerprint);
    }
  });

  test("retries a retrieval mismatch under the same fingerprint", async () => {
    await addDocument("retry-mismatch.md", "transientmismatchneedle evidence");
    let returnMismatches = true;
    const retryingStore = new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === "searchFts") {
          return async (...args: Parameters<StorePort["searchFts"]>) => {
            if (returnMismatches) {
              return {
                ok: true as const,
                value: [
                  {
                    mirrorHash: hash("wrong-mirror"),
                    seq: 0,
                    score: -1,
                    uri: "gno://notes/wrong.md",
                    sourceHash: hash("wrong-source"),
                  },
                ],
              };
            }
            return target.searchFts(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StorePort;

    const failed = await verifyLexicalActivation(
      retryingStore,
      "notes",
      verifierOptions
    );
    expect(failed.ok).toBe(true);
    if (!failed.ok) {
      return;
    }
    expect(failed.value.stages.lexical.code).toBe("retrieval_mismatch");

    returnMismatches = false;
    const recovered = await verifyLexicalActivation(
      retryingStore,
      "notes",
      verifierOptions
    );
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value.ready).toBe(true);
      expect(recovered.value.fingerprint).toBe(failed.value.fingerprint);
    }
  });

  test("invalidates a persisted receipt after source/index fingerprint changes", async () => {
    await addDocument("mutable.md", "firstuniqueterm evidence");
    const first = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    await addDocument("mutable.md", "seconduniqueterm replacement");
    const second = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }

    expect(second.value.fingerprint).not.toBe(first.value.fingerprint);
    expect(second.value.evidence.probeHash).not.toBe(
      first.value.evidence.probeHash
    );
    const row = adapter
      .getRawDb()
      .query<{ count: number; fingerprint: string }, []>(
        "SELECT COUNT(*) AS count, fingerprint FROM activation_receipts"
      )
      .get();
    expect(row).toEqual({
      count: 1,
      fingerprint: second.value.fingerprint,
    });
  });

  test("invalidates receipts when FTS synchronization state changes", async () => {
    await addDocument("race.md", "synchronizationneedle evidence", false);

    const beforeSync = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );
    expect(beforeSync.ok).toBe(true);
    if (!beforeSync.ok) {
      return;
    }
    expect(beforeSync.value.ready).toBe(false);
    expect(beforeSync.value.stages.index.code).toBe("index_out_of_sync");
    expect(beforeSync.value.stages.lexical).toMatchObject({
      status: "skipped",
      code: "index_out_of_sync",
    });

    expect((await adapter.syncDocumentFts("notes", "race.md")).ok).toBe(true);
    const afterSync = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );
    expect(afterSync.ok).toBe(true);
    if (!afterSync.ok) {
      return;
    }
    expect(afterSync.value.ready).toBe(true);
    expect(afterSync.value.fingerprint).not.toBe(beforeSync.value.fingerprint);

    adapter.getRawDb().run(
      `DELETE FROM documents_fts
       WHERE rowid = (SELECT id FROM documents WHERE collection = ? AND rel_path = ?)`,
      ["notes", "race.md"]
    );
    const afterFtsLoss = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );
    expect(afterFtsLoss.ok).toBe(true);
    if (afterFtsLoss.ok) {
      expect(afterFtsLoss.value.ready).toBe(false);
      expect(afterFtsLoss.value.fingerprint).not.toBe(
        afterSync.value.fingerprint
      );
    }
  });

  test("fails closed before probing when changed content has stale FTS", async () => {
    await addDocument("stale.md", "shared alpha evidence");
    const first = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );
    expect(first.ok && first.value.ready).toBe(true);

    await addDocument("stale.md", "shared beta evidence", false);
    let prefixReads = 0;
    let searches = 0;
    const staleStore = new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === "getContentPrefix") {
          return async (...args: Parameters<StorePort["getContentPrefix"]>) => {
            prefixReads += 1;
            return target.getContentPrefix(...args);
          };
        }
        if (property === "searchFts") {
          return async (...args: Parameters<StorePort["searchFts"]>) => {
            searches += 1;
            return target.searchFts(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StorePort;

    const stale = await verifyLexicalActivation(
      staleStore,
      "notes",
      verifierOptions
    );
    expect(stale.ok).toBe(true);
    if (stale.ok) {
      expect(stale.value.ready).toBe(false);
      expect(stale.value.stages.index.code).toBe("index_out_of_sync");
      expect(stale.value.fingerprint).not.toBe(
        first.ok ? first.value.fingerprint : ""
      );
    }
    expect(prefixReads).toBe(0);
    expect(searches).toBe(0);

    expect((await adapter.syncDocumentFts("notes", "stale.md")).ok).toBe(true);
    const recovered = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );
    expect(recovered.ok && recovered.value.ready).toBe(true);
  });

  test("deduplicates shared probes and accepts any exact matching source", async () => {
    const sharedTerms = Array.from(
      { length: 32 },
      (_, index) => `sharedterm${index}`
    ).join(" ");
    const paths = Array.from(
      { length: 12 },
      (_, index) => `${String.fromCharCode(97 + index)}.md`
    );
    for (const relPath of paths.toReversed()) {
      await addDocument(relPath, sharedTerms);
    }

    const result = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ready).toBe(true);
      expect(result.value.evidence.resultUri).toMatch(/^gno:\/\/notes\//);
    }
  });

  test("continues past non-probe documents to find usable evidence", async () => {
    for (let index = 0; index < 16; index += 1) {
      await addDocument(
        `${String(index).padStart(2, "0")}-no-probe.md`,
        "the and of to 12345"
      );
    }
    await addDocument("99-valid.md", "lateactivationneedle usable evidence");

    const result = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ready).toBe(true);
      expect(result.value.evidence.resultUri).toBe("gno://notes/99-valid.md");
    }
  });

  test("bounds cold probe reads by document count and content prefix", async () => {
    for (let index = 0; index < 64; index += 1) {
      await addDocument(
        `${String(index).padStart(2, "0")}-no-probe.md`,
        "the and of to ".repeat(4000)
      );
    }
    await addDocument("99-valid.md", "boundedactivationneedle evidence");

    let fullReads = 0;
    const requestedPrefixes: number[] = [];
    const boundedStore = new Proxy(adapter, {
      get(target, property, receiver) {
        if (property === "getContent") {
          return async (...args: Parameters<StorePort["getContent"]>) => {
            fullReads += 1;
            return target.getContent(...args);
          };
        }
        if (property === "getContentPrefix") {
          return async (...args: Parameters<StorePort["getContentPrefix"]>) => {
            requestedPrefixes.push(args[1]);
            return target.getContentPrefix(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StorePort;

    const result = await verifyLexicalActivation(
      boundedStore,
      "notes",
      verifierOptions
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ready).toBe(false);
      expect(result.value.stages.lexical.code).toBe("no_probe_term");
    }
    expect(fullReads).toBe(0);
    expect(requestedPrefixes).toHaveLength(64);
    expect(new Set(requestedPrefixes)).toEqual(new Set([32_768]));
  });

  test("persists no raw term, query, snippet, or passage", async () => {
    const secretTerm = "confidentialzephyrneedle";
    await addDocument("private.md", `${secretTerm} restricted passage body`);
    const result = await verifyLexicalActivation(
      adapter,
      "notes",
      verifierOptions
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.evidence.probeHash).not.toBe(hash(secretTerm));
    }

    await adapter.close();
    const db = new Database(dbPath, { readonly: true });
    try {
      const raw = db
        .query<{ receipt_json: string }, []>(
          "SELECT receipt_json FROM activation_receipts"
        )
        .get()?.receipt_json;
      expect(raw).toBeDefined();
      expect(raw).not.toContain(secretTerm);
      expect(raw).not.toContain("restricted passage body");
      expect(raw).not.toContain("snippet");
      expect(raw).not.toContain('"query":');
    } finally {
      db.close();
    }
  });
});
