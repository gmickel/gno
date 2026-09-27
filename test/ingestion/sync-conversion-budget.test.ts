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
import type {
  ChunkerPort,
  SlowConversionEvent,
} from "../../src/ingestion/types";

import { buildLargeWorkbook } from "../../scripts/generate-large-workbook";
import { defaultChunker } from "../../src/ingestion/chunker";
import {
  type FileProcessorBackendKind,
  fileProcessorsStarted,
  useFileProcessorBackend,
} from "../../src/ingestion/file-processor";
import { SyncService } from "../../src/ingestion/sync";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

/** Both file processor backends: worker (source), child (compiled). */
const BACKENDS: FileProcessorBackendKind[] = ["worker", "child"];

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
    useFileProcessorBackend(null);
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

  const writeWorkbookAndNote = async () => {
    // Most of a second to convert: past a 250 ms budget, while the note
    // indexes in milliseconds.
    await Bun.write(
      join(root, "report.xlsx"),
      buildLargeWorkbook({ scale: 0.25 })
    );
    await Bun.write(join(root, "notes.md"), "# Notes\n\nPlain note.\n");
  };

  test("a workbook over its time budget is stopped, the rest indexes, and the next run retries it", async () => {
    await writeWorkbookAndNote();
    const service = new SyncService();

    const stopped = await service.syncCollection(collection, adapter, {
      limits: { timeoutMs: 250 },
    });

    expect(stopped.filesAdded).toBe(1);
    expect(stopped.errors).toEqual([
      expect.objectContaining({ relPath: "report.xlsx", code: "TIMEOUT" }),
    ]);
    expect(await lastErrorCode("report.xlsx")).toBe("TIMEOUT");
    expect(await lastErrorCode("notes.md")).toBeNull();

    const retried = await service.syncCollection(collection, adapter);

    expect(retried.filesErrored).toBe(0);
    expect(await lastErrorCode("report.xlsx")).toBeNull();
  }, 30_000);

  test.each(BACKENDS)(
    "%s backend: the memory ceiling stops every file and recycles the processor",
    async (backend) => {
      useFileProcessorBackend(backend);
      await writeWorkbookAndNote();
      const service = new SyncService();

      const stopped = await service.syncCollection(collection, adapter, {
        limits: { maxMemoryMb: 1 },
      });

      expect(stopped.errors).toEqual(
        expect.arrayContaining(
          ["report.xlsx", "notes.md"].map((relPath) =>
            expect.objectContaining({ relPath, code: "MEMORY_LIMIT" })
          )
        )
      );
      const startedBeforeRetry = fileProcessorsStarted();

      const retried = await service.syncCollection(collection, adapter);

      expect(retried.filesErrored).toBe(0);
      // The stopped worker was discarded; the retry needed a fresh one.
      expect(fileProcessorsStarted()).toBeGreaterThan(startedBeforeRetry);
      expect(await lastErrorCode("report.xlsx")).toBeNull();
      expect(await lastErrorCode("notes.md")).toBeNull();
    },
    30_000
  );

  test.each(BACKENDS)(
    "%s backend: a Markdown step past its budget is stopped mid-step, named while it runs, and the next file indexes",
    async (backend) => {
      useFileProcessorBackend(backend);
      // 80,000 table rows: code-region parsing alone takes several seconds.
      const rows = Array.from(
        { length: 80_000 },
        (_, row) => `| row ${row} | \`code ${row}\` | [[n${row}]] | 1.5 |`
      );
      await Bun.write(
        join(root, "big-table.md"),
        [
          "# Big",
          "",
          "| a | b | c | d |",
          "| --- | --- | --- | --- |",
          ...rows,
        ].join("\n")
      );
      await Bun.write(join(root, "notes.md"), "# Notes\n\nPlain note.\n");
      const events: SlowConversionEvent[] = [];
      const budgetMs = 1000;

      const started = performance.now();
      const result = await new SyncService().syncCollection(
        collection,
        adapter,
        {
          limits: { timeoutMs: budgetMs },
          onSlowConversion: (event) => events.push(event),
        }
      );
      const elapsedMs = performance.now() - started;

      expect(result.errors).toEqual([
        expect.objectContaining({
          relPath: "big-table.md",
          code: "TIMEOUT",
          message: expect.stringContaining("Indexing stopped during"),
        }),
      ]);
      expect(await lastErrorCode("notes.md")).toBeNull();
      expect(elapsedMs).toBeLessThan(2 * budgetMs);
      expect(events).toEqual([
        expect.objectContaining({ relPath: "big-table.md", budgetMs }),
      ]);
    },
    30_000
  );

  test("in-process preparation checks the budget between steps: that file stops, the next run retries it", async () => {
    await Bun.write(join(root, "slow.md"), "# Slow\n\nBody.\n");
    await Bun.write(join(root, "fast.md"), "# Fast\n\nBody.\n");
    // A chunker that overruns the budget for one file (a synchronous phase
    // cannot be interrupted; the checkpoint after it stops the file).
    const slowChunker: ChunkerPort = {
      chunk: (markdown, params, languageHint, sourcePath) => {
        if (sourcePath === "slow.md") {
          const until = performance.now() + 300;
          while (performance.now() < until) {
            // busy phase
          }
        }
        return defaultChunker.chunk(markdown, params, languageHint, sourcePath);
      },
    };

    const stopped = await new SyncService(
      undefined,
      slowChunker
    ).syncCollection(collection, adapter, { limits: { timeoutMs: 200 } });

    expect(stopped.errors).toEqual([
      expect.objectContaining({
        relPath: "slow.md",
        code: "TIMEOUT",
        message: expect.stringContaining("during chunking"),
      }),
    ]);
    expect(await lastErrorCode("slow.md")).toBe("TIMEOUT");
    expect(await lastErrorCode("fast.md")).toBeNull();

    const retried = await new SyncService().syncCollection(collection, adapter);

    expect(retried.filesErrored).toBe(0);
    expect(await lastErrorCode("slow.md")).toBeNull();
  });

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
