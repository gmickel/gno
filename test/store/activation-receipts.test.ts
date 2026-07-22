import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActivationVerificationReceipt } from "../../src/store/types";

import { SqliteAdapter } from "../../src/store";
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
});
