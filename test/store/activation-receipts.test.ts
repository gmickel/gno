import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActivationVerificationReceipt } from "../../src/store/types";

import { SqliteAdapter } from "../../src/store";
import {
  parseActivationReceipt,
  serializeActivationReceipt,
} from "../../src/store/activation-receipts";
import { ACTIVATION_INDEX_SNAPSHOT_SQL } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const FINGERPRINT = "a".repeat(64);

function receipt(
  overrides: Partial<ActivationVerificationReceipt> = {}
): ActivationVerificationReceipt {
  return {
    schemaVersion: "1.0",
    collection: "notes",
    fingerprint: FINGERPRINT,
    ready: true,
    generatedAt: "2026-07-22T10:00:00.000Z",
    stages: {
      index: {
        status: "passed",
        startedAt: "2026-07-22T09:59:59.000Z",
        completedAt: "2026-07-22T10:00:00.000Z",
        latencyMs: 2,
      },
      lexical: {
        status: "passed",
        startedAt: "2026-07-22T10:00:00.000Z",
        completedAt: "2026-07-22T10:00:00.000Z",
        latencyMs: 1,
      },
      semantic: {
        status: "pending",
        startedAt: null,
        completedAt: null,
        latencyMs: null,
        code: "semantic_not_checked",
      },
      connector: {
        status: "skipped",
        startedAt: null,
        completedAt: null,
        latencyMs: null,
        code: "connector_not_requested",
      },
    },
    evidence: {
      probeHash: "b".repeat(64),
      resultUri: "gno://notes/proof.md",
      resultSourceHash: "c".repeat(64),
    },
    ...overrides,
  };
}

describe("activation receipt store", () => {
  let adapter: SqliteAdapter;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-activation-store-test-"));
    adapter = new SqliteAdapter();
    expect(
      (await adapter.open(join(testDir, "index-test.sqlite"), "unicode61")).ok
    ).toBe(true);
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
          {
            name: "other",
            path: "/other",
            pattern: "**/*",
            include: [],
            exclude: [],
          },
        ])
      ).ok
    ).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test("round-trips the strict bounded receipt and removes stale fingerprints", async () => {
    const value = receipt();
    expect((await adapter.upsertActivationReceipt(value)).ok).toBe(true);

    const current = await adapter.getActivationReceipt("notes", FINGERPRINT);
    expect(current).toEqual({ ok: true, value });

    const stale = await adapter.getActivationReceipt("notes", "d".repeat(64));
    expect(stale).toEqual({ ok: true, value: null });
    expect(
      adapter
        .getRawDb()
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM activation_receipts"
        )
        .get()?.count
    ).toBe(0);
  });

  test("projects unknown properties out before persistence", async () => {
    const unsafe = receipt() as ActivationVerificationReceipt & {
      query: string;
      evidence: ActivationVerificationReceipt["evidence"] & {
        snippet: string;
      };
    };
    unsafe.query = "private-query";
    unsafe.evidence.snippet = "private-passage";

    expect((await adapter.upsertActivationReceipt(unsafe)).ok).toBe(true);
    const raw = adapter
      .getRawDb()
      .query<{ receipt_json: string }, []>(
        "SELECT receipt_json FROM activation_receipts"
      )
      .get()?.receipt_json;
    expect(raw).not.toContain("private-query");
    expect(raw).not.toContain("private-passage");
  });

  test("rejects schema-invalid receipts before persistence", async () => {
    const invalid = receipt({ fingerprint: "not-a-sha256" });
    const result = await adapter.upsertActivationReceipt(invalid);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
      expect(result.error.message).toContain("schema-invalid");
    }
  });

  test("applies stage-specific status code timing and evidence invariants at runtime", () => {
    const base = receipt();
    const target = `mcp:cursor:user:${"e".repeat(64)}`;
    const timed = (
      status: "passed" | "failed" | "skipped",
      code?: ActivationVerificationReceipt["stages"]["index"]["code"]
    ) => ({
      status,
      startedAt: "2026-07-22T10:00:00.000Z",
      completedAt: "2026-07-22T10:00:00.000Z",
      latencyMs: 1,
      ...(code ? { code } : {}),
    });
    const invalid = [
      receipt({
        stages: {
          ...base.stages,
          index: timed("failed", "no_probe_term"),
        },
      }),
      receipt({
        stages: {
          ...base.stages,
          lexical: timed("failed", "no_documents"),
        },
      }),
      receipt({
        stages: {
          ...base.stages,
          semantic: {
            ...base.stages.semantic,
            completedAt: "2026-07-22T10:00:00.000Z",
          },
        },
      }),
      receipt({
        stages: {
          ...base.stages,
          connector: timed("failed", "connector_not_configured"),
        },
        evidence: { ...base.evidence, connectorTarget: target },
      }),
      receipt({ ready: false }),
      receipt({ evidence: { probeHash: "b".repeat(64) } }),
      receipt({
        evidence: { ...base.evidence, connectorTarget: target },
      }),
      receipt({
        ready: false,
        stages: {
          ...base.stages,
          lexical: timed("failed", "no_probe_term"),
          connector: timed("passed"),
        },
        evidence: { connectorTarget: target },
      }),
      receipt({
        stages: {
          ...base.stages,
          connector: timed("skipped", "connector_probe_unavailable"),
        },
        evidence: { ...base.evidence, connectorTarget: target },
      }),
      receipt({
        ready: false,
        stages: {
          ...base.stages,
          lexical: timed("failed", "no_probe_term"),
          connector: timed("failed", "connector_timeout"),
        },
        evidence: { connectorTarget: target },
      }),
    ];

    for (const value of invalid) {
      expect(serializeActivationReceipt(value).ok).toBe(false);
      expect(parseActivationReceipt(JSON.stringify(value))).toBeNull();
    }

    const mismatch = receipt({
      ready: false,
      stages: {
        ...base.stages,
        lexical: timed("failed", "retrieval_mismatch"),
      },
      evidence: { probeHash: "b".repeat(64) },
    });
    expect(serializeActivationReceipt(mismatch).ok).toBe(true);
    expect(parseActivationReceipt(JSON.stringify(mismatch))).toEqual(mismatch);
  });

  test("rejects calendar-invalid timestamps at every runtime entry point", () => {
    for (const generatedAt of [
      "2026-02-29T10:00:00Z",
      "2026-04-31T10:00:00Z",
      "2026-07-22T24:00:00Z",
      "2026-07-22T10:00:00+24:00",
    ]) {
      const invalid = receipt({ generatedAt });
      expect(serializeActivationReceipt(invalid).ok).toBe(false);
      expect(parseActivationReceipt(JSON.stringify(invalid))).toBeNull();
    }
  });

  test("enforces the 16 KiB persistence ceiling", () => {
    const serialized = serializeActivationReceipt(
      receipt({
        collection: "n".repeat(128),
        evidence: {
          ...receipt().evidence,
          resultUri: `gno://notes/${"x".repeat(2036)}`,
        },
      })
    );
    expect(serialized.ok).toBe(true);
    if (serialized.ok) {
      expect(
        new TextEncoder().encode(serialized.json).byteLength
      ).toBeLessThanOrEqual(16_384);
    }

    expect(() =>
      adapter.getRawDb().run(
        `INSERT INTO activation_receipts (
           collection, connector_target, schema_version, fingerprint,
           receipt_json, updated_at
         ) VALUES (?, '', '1.0', ?, ?, datetime('now'))`,
        ["notes", FINGERPRINT, "x".repeat(16_385)]
      )
    ).toThrow();
  });

  test("rejects raw-path connector target identities before persistence", async () => {
    const base = receipt();
    const invalid = receipt({
      stages: {
        ...base.stages,
        connector: {
          status: "failed",
          startedAt: "2026-07-22T10:00:00.000Z",
          completedAt: "2026-07-22T10:00:00.000Z",
          latencyMs: 1,
          code: "connector_unsupported_config",
        },
      },
      evidence: {
        ...base.evidence,
        connectorTarget: "mcp:cursor:user:/Users/private/.cursor/mcp.json",
      },
    });

    const result = await adapter.upsertActivationReceipt(invalid);
    expect(result.ok).toBe(false);
    expect(
      adapter
        .getRawDb()
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM activation_receipts"
        )
        .get()?.count
    ).toBe(0);
  });

  test("deletes corrupt or row-mismatched receipt JSON on read", async () => {
    const db = adapter.getRawDb();
    const insert = (
      collection: string,
      connectorTarget: string,
      value: unknown
    ): void => {
      db.run(
        `INSERT OR REPLACE INTO activation_receipts (
           collection, connector_target, schema_version, fingerprint,
           receipt_json, updated_at
         ) VALUES (?, ?, '1.0', ?, ?, datetime('now'))`,
        [collection, connectorTarget, FINGERPRINT, JSON.stringify(value)]
      );
    };

    insert("notes", "", {
      ...receipt(),
      generatedAt: "not-a-date",
      evidence: { resultUri: "not-a-gno-uri" },
    });
    expect(await adapter.getActivationReceipt("notes", FINGERPRINT)).toEqual({
      ok: true,
      value: null,
    });

    insert("notes", "", {
      ...receipt(),
      generatedAt: "2026-02-31T10:00:00Z",
    });
    expect(await adapter.getActivationReceipt("notes", FINGERPRINT)).toEqual({
      ok: true,
      value: null,
    });

    insert("notes", "", receipt({ collection: "other" }));
    expect(await adapter.getActivationReceipt("notes", FINGERPRINT)).toEqual({
      ok: true,
      value: null,
    });

    insert("notes", "mcp-local", receipt());
    expect(
      await adapter.getActivationReceipt("notes", FINGERPRINT, "mcp-local")
    ).toEqual({ ok: true, value: null });

    insert(
      "notes",
      "",
      receipt({
        stages: {
          ...receipt().stages,
          lexical: {
            status: "failed",
            startedAt: "2026-07-22T10:00:00.000Z",
            completedAt: "2026-07-22T10:00:00.000Z",
            latencyMs: 1,
            code: "retrieval_mismatch",
          },
        },
        evidence: {},
      })
    );
    expect(await adapter.getActivationReceipt("notes", FINGERPRINT)).toEqual({
      ok: true,
      value: null,
    });

    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM activation_receipts"
        )
        .get()?.count
    ).toBe(0);
  });

  test("scopes the FTS candidate limit before BM25 ranking", async () => {
    const addDocument = async (
      collection: string,
      relPath: string,
      title: string,
      body: string
    ): Promise<void> => {
      const sourceHash = new Bun.CryptoHasher("sha256")
        .update(`${collection}:${relPath}:${body}`)
        .digest("hex");
      const mirrorHash = new Bun.CryptoHasher("sha256")
        .update(body)
        .digest("hex");
      expect(
        (
          await adapter.upsertDocument({
            collection,
            relPath,
            title,
            sourceHash,
            mirrorHash,
            sourceMime: "text/markdown",
            sourceExt: ".md",
            sourceSize: body.length,
            sourceMtime: "2026-07-22T10:00:00.000Z",
          })
        ).ok
      ).toBe(true);
      expect((await adapter.upsertContent(mirrorHash, body)).ok).toBe(true);
      expect((await adapter.syncDocumentFts(collection, relPath)).ok).toBe(
        true
      );
    };

    await addDocument("notes", "target.md", "Target", "sharedterm in body");
    for (let index = 0; index < 20; index += 1) {
      await addDocument(
        "other",
        `strong-${index}.md`,
        "sharedterm sharedterm",
        "sharedterm"
      );
    }

    const result = await adapter.searchFts("sharedterm", {
      collection: "notes",
      limit: 1,
      snippet: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.map((item) => item.uri)).toEqual([
      "gno://notes/target.md",
    ]);
  });

  test("tracks owned FTS synchronization without reading indexed bodies", async () => {
    expect(ACTIVATION_INDEX_SNAPSHOT_SQL).not.toMatch(/\bbody\b/i);
    expect(ACTIVATION_INDEX_SNAPSHOT_SQL).not.toMatch(/\bmarkdown\b/i);
    expect(ACTIVATION_INDEX_SNAPSHOT_SQL).not.toMatch(/\bcontent\b/i);

    const firstBody = "shared alpha evidence";
    const firstMirror = new Bun.CryptoHasher("sha256")
      .update(firstBody)
      .digest("hex");
    expect(
      (
        await adapter.upsertDocument({
          collection: "notes",
          relPath: "tracked.md",
          title: "Tracked",
          sourceHash: "1".repeat(64),
          mirrorHash: firstMirror,
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceSize: firstBody.length,
          sourceMtime: "2026-07-22T10:00:00.000Z",
        })
      ).ok
    ).toBe(true);
    expect((await adapter.upsertContent(firstMirror, firstBody)).ok).toBe(true);

    const unsynchronized = await adapter.getActivationIndexSnapshot("notes");
    expect(unsynchronized.ok).toBe(true);
    if (!unsynchronized.ok) {
      return;
    }
    expect(unsynchronized.value.identity).toMatchObject({
      activeDocumentCount: 1,
      ftsSynchronized: false,
    });

    expect((await adapter.syncDocumentFts("notes", "tracked.md")).ok).toBe(
      true
    );
    const documentSync = await adapter.getActivationIndexSnapshot("notes");
    expect(documentSync.ok && documentSync.value.identity.ftsSynchronized).toBe(
      true
    );

    adapter
      .getRawDb()
      .run("UPDATE documents SET fts_mirror_hash = NULL WHERE rel_path = ?", [
        "tracked.md",
      ]);
    expect((await adapter.rebuildAllDocumentsFts()).ok).toBe(true);
    const fullRebuild = await adapter.getActivationIndexSnapshot("notes");
    expect(fullRebuild.ok && fullRebuild.value.identity.ftsSynchronized).toBe(
      true
    );

    adapter.getRawDb().run(
      `DELETE FROM documents_fts
       WHERE rowid = (SELECT id FROM documents WHERE rel_path = ?)`,
      ["tracked.md"]
    );
    expect((await adapter.rebuildFtsForHash(firstMirror)).ok).toBe(true);
    const hashRebuild = await adapter.getActivationIndexSnapshot("notes");
    expect(hashRebuild.ok && hashRebuild.value.identity.ftsSynchronized).toBe(
      true
    );
  });
});
