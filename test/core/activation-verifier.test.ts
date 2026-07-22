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

  async function addDocument(relPath: string, markdown: string): Promise<void> {
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
    expect((await adapter.syncDocumentFts("notes", relPath)).ok).toBe(true);
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
