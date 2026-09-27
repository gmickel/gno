/**
 * Per-file conversion budget and bounded post-conversion processing (fn-198).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises: mkdtemp/mkdir have no Bun equivalent.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os tmpdir: no Bun equivalent.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { ConversionPipeline } from "../../src/converters/pipeline";
import type { SlowConversionEvent } from "../../src/ingestion/types";

import { buildLargeWorkbook } from "../../scripts/generate-large-workbook";
import { SyncService } from "../../src/ingestion/sync";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

describe("SyncService conversion budget (fn-198)", () => {
  let adapter: SqliteAdapter;
  let collection: Collection;
  let root: string;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-sync-budget-test-"));
    root = join(tmpDir, "docs");
    await mkdir(root, { recursive: true });
    adapter = new SqliteAdapter();
    expect((await adapter.open(join(tmpDir, "test.db"), "porter")).ok).toBe(
      true
    );
    collection = {
      name: "docs",
      path: root,
      pattern: "**/*",
      include: [],
      exclude: [],
    };
    expect((await adapter.syncCollections([collection])).ok).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(tmpDir);
  });

  const lastErrorCode = async (relPath: string) => {
    const document = await adapter.getDocument(collection.name, relPath);
    return document.ok ? document.value?.lastErrorCode : undefined;
  };

  test("converted text holding a spreadsheet-sized table indexes promptly", async () => {
    // Plain text passes through unconverted: one 20,000-row pipe table with
    // backticks, the shape of converted workbook output. 2.8.2 ran the GFM
    // table parser on it (quadratic in cells) and never finished.
    const rows = Array.from(
      { length: 20_000 },
      (_, row) => `| ${row} | didn\`t ship | [x](note-${row}.md) | 1.5 |`
    );
    await Bun.write(join(root, "export.txt"), rows.join("\n"));

    const result = await new SyncService().syncCollection(collection, adapter);

    expect(result.filesAdded).toBe(1);
    expect(result.errors).toEqual([]);
    const document = await adapter.getDocument(collection.name, "export.txt");
    expect(document.ok && document.value?.mirrorHash).toBeTruthy();
    const links = await adapter.getLinksForDoc(
      document.ok ? (document.value?.id ?? 0) : 0
    );
    expect(links.ok && links.value).toEqual([]);
  });

  test.each([
    { code: "TIMEOUT", limits: { timeoutMs: 1 } },
    { code: "MEMORY_LIMIT", limits: { maxMemoryMb: 1 } },
  ])(
    "a workbook over its $code budget is recorded, the rest indexes, and the next run retries it",
    async ({ code, limits }) => {
      await Bun.write(
        join(root, "report.xlsx"),
        buildLargeWorkbook({ scale: 0.1, sheets: 1, metricColumns: 4 })
      );
      await Bun.write(join(root, "notes.md"), "# Notes\n\nPlain note.\n");
      const service = new SyncService();

      const stopped = await service.syncCollection(collection, adapter, {
        limits,
      });

      expect(stopped.filesAdded).toBe(1);
      expect(stopped.filesErrored).toBe(1);
      expect(stopped.errors).toEqual([
        expect.objectContaining({ relPath: "report.xlsx", code }),
      ]);
      expect(await lastErrorCode("report.xlsx")).toBe(code);
      expect(await lastErrorCode("notes.md")).toBeNull();

      const retried = await service.syncCollection(collection, adapter);

      expect(retried.filesErrored).toBe(0);
      expect(await lastErrorCode("report.xlsx")).toBeNull();
    }
  );

  test("a conversion still running at half its budget is reported by path", async () => {
    await mkdir(join(root, "nested"), { recursive: true });
    await Bun.write(join(root, "nested", "slow.pdf"), "%PDF-1.7\n");
    const pipeline = {
      convert: async () => {
        await Bun.sleep(400);
        return {
          ok: true as const,
          value: {
            markdown: "# Slow\n",
            mirrorHash: "a".repeat(64),
            meta: {
              converterId: "test/slow",
              converterVersion: "1",
              sourceMime: "application/pdf",
            },
          },
        };
      },
    };
    const events: SlowConversionEvent[] = [];
    const service = new SyncService(
      undefined,
      undefined,
      undefined,
      pipeline as unknown as ConversionPipeline
    );

    await service.syncCollection(collection, adapter, {
      limits: { timeoutMs: 200 },
      onSlowConversion: (event) => events.push(event),
    });

    expect(events).toEqual([
      expect.objectContaining({
        collection: "docs",
        relPath: "nested/slow.pdf",
        budgetMs: 200,
      }),
    ]);
  });
});
