import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises for mkdtemp, mkdir, rm (no Bun directory lifecycle APIs)
import { mkdir, mkdtemp, rm } from "node:fs/promises";
// node:os for tmpdir (no Bun equivalent)
import { tmpdir } from "node:os";
// node:path for join (no Bun path utils)
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type {
  RecordAdapter,
  RecordAdapterEvent,
} from "../../src/converters/types";
import type { StorePort } from "../../src/store/types";

import { normalizeContentTypes } from "../../src/config";
import { browserExportAdapter } from "../../src/converters/adapters/browser-export/adapter";
import { emailRecordAdapter } from "../../src/converters/adapters/email/adapter";
import { icalAdapter } from "../../src/converters/adapters/ical/adapter";
import { htmlFragmentToText } from "../../src/converters/adapters/shared/html-text";
import {
  includesBytes,
  isPasswordProtectedXlsx,
  utf16le,
} from "../../src/converters/adapters/shared/ooxml-protection";
import { readBoundedUtf8Lines } from "../../src/converters/adapters/shared/utf8-lines";
import { canonicalize, mirrorHash } from "../../src/converters/canonicalize";
import { markdownConverter } from "../../src/converters/native/markdown";
import { plaintextConverter } from "../../src/converters/native/plaintext";
import { createDefaultRegistry } from "../../src/converters/registry";
import { defaultChunker } from "../../src/ingestion/chunker";
import { isCompiledContextPath } from "../../src/ingestion/compiled-context";
import {
  defaultConversionMemoryMb,
  disposeFileProcessor,
  prepareInProcessor,
} from "../../src/ingestion/file-processor";
import {
  parseFrontmatter,
  parseFrontmatterDetails,
} from "../../src/ingestion/frontmatter";
import { projectGraph } from "../../src/ingestion/graph-reconciliation";
import { defaultLanguageDetector } from "../../src/ingestion/language";
import { buildLineOffsets } from "../../src/ingestion/position";
import {
  recordAdapterFingerprint,
  runRecordAdapter,
} from "../../src/ingestion/record-adapter";
import {
  getExcludedRanges,
  MAX_PARSED_TABLE_CELLS,
} from "../../src/ingestion/strip";
import { SyncService } from "../../src/ingestion/sync";
import { DEFAULT_CHUNK_PARAMS } from "../../src/ingestion/types";
import { defaultWalker } from "../../src/ingestion/walker";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { err } from "../../src/store/types";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  disposeFileProcessor();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("R1: file-processor replaceable failure slot and ArrayBuffer transfer", () => {
  test("transfers unshared full-buffer Uint8Array without copying and preserves sub-views", async () => {
    const markdown = "# Transfer Test\n\nBody with [[Target]] and #tag.\n";
    const fullBytes = new TextEncoder().encode(markdown);
    const backing = new Uint8Array(fullBytes.byteLength + 8);
    backing.set(fullBytes, 4);
    const subView = backing.subarray(4, 4 + fullBytes.byteLength);

    const baseRequest = (bytes: Uint8Array) => ({
      input: {
        sourcePath: "/tmp/transfer.md",
        relativePath: "transfer.md",
        collection: "notes",
        bytes,
        mime: "text/markdown",
        ext: ".md",
        limits: {
          maxBytes: 10 * 1024 * 1024,
          timeoutMs: 30_000,
          maxOutputChars: 10 * 1024 * 1024,
        },
      },
      metadataExt: ".md",
      contentTypeRules: [],
      chunkParams: DEFAULT_CHUNK_PARAMS,
      memoryManaged: false,
      markdownSource: true,
      previous: null,
    });

    const budget = {
      timeoutMs: 30_000,
      maxMemoryBytes: Math.max(
        defaultConversionMemoryMb() * 1024 * 1024,
        process.memoryUsage.rss() + 512 * 1024 * 1024
      ),
    };

    const noopPrevious = () => {};
    const copied = await prepareInProcessor(baseRequest(subView), budget, {
      onPrevious: noopPrevious,
      transferInputBytes: true,
    });
    expect(copied.ok).toBe(true);
    // Sub-view shares a larger ArrayBuffer: must NOT be detached.
    expect(backing.buffer.byteLength).toBe(fullBytes.byteLength + 8);

    const transferred = await prepareInProcessor(
      baseRequest(fullBytes),
      budget,
      { onPrevious: noopPrevious, transferInputBytes: true }
    );
    expect(transferred.ok).toBe(true);
    // Full unshared buffer transferred cleanly to worker.
    expect(fullBytes.buffer.byteLength).toBe(0);

    if (copied.ok && transferred.ok) {
      expect(transferred.value.artifact.mirrorHash).toBe(
        copied.value.artifact.mirrorHash
      );
      expect(transferred.value.chunkInputs).toEqual(copied.value.chunkInputs);
      expect(transferred.value.linkInputs).toEqual(copied.value.linkInputs);
      expect(transferred.value.tags).toEqual(copied.value.tags);
    }
  });

  test("sequential files reuse worker cleanly and recover after forced stop", async () => {
    const noopPrevious = () => {};
    const budget = {
      timeoutMs: 30_000,
      maxMemoryBytes: Math.max(
        defaultConversionMemoryMb() * 1024 * 1024,
        process.memoryUsage.rss() + 512 * 1024 * 1024
      ),
    };
    for (let i = 0; i < 12; i += 1) {
      const bytes = new TextEncoder().encode(`# Doc ${i}\n\nParagraph ${i}.\n`);
      const res = await prepareInProcessor(
        {
          input: {
            sourcePath: `/tmp/doc-${i}.md`,
            relativePath: `doc-${i}.md`,
            collection: "notes",
            bytes,
            mime: "text/markdown",
            ext: ".md",
            limits: {
              maxBytes: 1024 * 1024,
              timeoutMs: 30_000,
              maxOutputChars: 1024 * 1024,
            },
          },
          metadataExt: ".md",
          contentTypeRules: [],
          chunkParams: DEFAULT_CHUNK_PARAMS,
          memoryManaged: false,
          markdownSource: true,
          previous: null,
        },
        budget,
        { onPrevious: noopPrevious, transferInputBytes: true }
      );
      expect(res.ok).toBe(true);
    }
    disposeFileProcessor();
    const afterStop = await prepareInProcessor(
      {
        input: {
          sourcePath: "/tmp/after.md",
          relativePath: "after.md",
          collection: "notes",
          bytes: new TextEncoder().encode("# After Stop\n"),
          mime: "text/markdown",
          ext: ".md",
          limits: {
            maxBytes: 1024 * 1024,
            timeoutMs: 30_000,
            maxOutputChars: 1024 * 1024,
          },
        },
        metadataExt: ".md",
        contentTypeRules: [],
        chunkParams: DEFAULT_CHUNK_PARAMS,
        memoryManaged: false,
        markdownSource: true,
        previous: null,
      },
      budget,
      { onPrevious: noopPrevious }
    );
    expect(afterStop.ok).toBe(true);
  });
});

describe("R2: lazy converter & record-adapter registry loading", () => {
  test("createDefaultRegistry + Markdown conversion does not load xlsx, turndown, or record adapter modules", async () => {
    const probeScript = `
      const loaded = [];
      Bun.plugin({
        name: "lazy-load-probe",
        setup(build) {
          build.onLoad({ filter: /(?:node_modules[\\\\/](?:xlsx|turndown|@joplin[\\\\/]turndown-plugin-gfm)|adapters[\\\\/](?:xlsx|ical|email|browser-export|jsonl|transcript)[\\\\/]adapter\\.ts$)/ }, (args) => {
            loaded.push(args.path);
            return undefined;
          });
        },
      });
      const { createDefaultRegistry } = await import("./src/converters/registry.ts");
      const registry = await createDefaultRegistry();
      const md = registry.select("text/markdown", ".md");
      if (!md) throw new Error("missing markdown converter");
      const converted = await md.convert({
        sourcePath: "/tmp/a.md",
        relativePath: "a.md",
        collection: "notes",
        bytes: new TextEncoder().encode("# Hello\\n"),
        mime: "text/markdown",
        ext: ".md",
        limits: { maxBytes: 1024 * 1024, timeoutMs: 10000, maxOutputChars: 1024 * 1024 },
      });
      if (!converted.ok) throw new Error("markdown convert failed");
      const jsonl = registry.selectRecordAdapter("application/x-ndjson", ".jsonl");
      const transcript = registry.selectRecordAdapter("text/vtt", ".vtt");
      console.log(JSON.stringify({
        loaded,
        jsonlMeta: jsonl ? { id: jsonl.id, version: jsonl.version, fp: jsonl.configurationFingerprint } : null,
        transcriptMeta: transcript ? { id: transcript.id, version: transcript.version, fp: transcript.configurationFingerprint } : null,
      }));
    `;
    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", probeScript],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim()) as {
      loaded: string[];
      jsonlMeta: { id: string; version: string; fp: string } | null;
      transcriptMeta: { id: string; version: string; fp: string } | null;
    };
    expect(parsed.loaded).toEqual([]);
    expect(parsed.jsonlMeta).toEqual({
      id: "adapter/jsonl",
      version: "1.0.0",
      fp: "35e7c3045f7eef59f74a6b6bfe450e5e50f37ef5e023edd0bc1c4327035cc5a2",
    });
    expect(parsed.transcriptMeta).toEqual({
      id: "adapter/transcript",
      version: "1.0.0",
      fp: "f1de45113a28155cdbe998e44af239561c91e4357cfd9a7b05f7765f5ba20cf4",
    });
  });

  test("registry exposes all 5 lazy record adapters and routes unsupported files identically", async () => {
    const registry = await createDefaultRegistry();
    expect(registry.selectRecordAdapter("text/calendar", ".ics")?.id).toBe(
      "adapter/ical-export"
    );
    expect(registry.selectRecordAdapter("message/rfc822", ".eml")?.id).toBe(
      "native/email-export"
    );
    expect(
      registry.selectRecordAdapter("application/x-ndjson", ".jsonl")?.id
    ).toBe("adapter/jsonl");
    expect(registry.selectRecordAdapter("text/vtt", ".vtt")?.id).toBe(
      "adapter/transcript"
    );
    expect(
      registry.selectRecordAdapter(
        "application/x-gno-browser-export+json",
        ".browser-export"
      )?.id
    ).toBe("adapter/browser-export");
    expect(
      registry.select("application/octet-stream", ".unknownbin")
    ).toBeUndefined();
  });
});

describe("R3: walker compiled matchers and subtree pruning", () => {
  test("prunes excluded subtrees and skips dotfiles unless pattern targets them", async () => {
    const dir = await makeTempDir("gno-walk-perf-");
    await mkdir(join(dir, ".git", "objects"), { recursive: true });
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(dir, ".hidden"), { recursive: true });
    await mkdir(join(dir, "notes", "sub"), { recursive: true });
    await Bun.write(join(dir, ".git", "objects", "ignored.md"), "nope");
    await Bun.write(join(dir, "node_modules", "pkg", "readme.md"), "nope");
    await Bun.write(join(dir, ".hidden", "secret.md"), "nope");
    await Bun.write(join(dir, "notes", "a.md"), "# A\n");
    await Bun.write(join(dir, "notes", "sub", "b.md"), "# B\n");

    const { entries, skipped } = await defaultWalker.walk({
      root: dir,
      pattern: "**/*",
      include: [".md"],
      exclude: [".git", "node_modules"],
      maxBytes: 1024 * 1024,
    });

    expect(entries.map((e) => e.relPath)).toEqual([
      "notes/a.md",
      "notes/sub/b.md",
    ]);
    // Subtrees pruned silently at directory boundary without descending or emitting synthetic dir skips.
    expect(skipped.some((s) => s.relPath.startsWith("node_modules/"))).toBe(
      false
    );
    expect(isCompiledContextPath("docs/brief.GNO-CONTEXT.md")).toBe(true);
    expect(isCompiledContextPath("docs/normal.md")).toBe(false);
  });

  test("preserves partial glob exclusion descendants and per-branch dotfile matching", async () => {
    const dir = await makeTempDir("gno-walk-edge-");
    await mkdir(join(dir, "docs", "integrations"), { recursive: true });
    await mkdir(join(dir, "src", "converters"), { recursive: true });
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await mkdir(join(dir, ".github", ".secret"), { recursive: true });
    await mkdir(join(dir, ".flow", "tasks"), { recursive: true });
    await mkdir(join(dir, ".agents", "skills"), { recursive: true });
    await Bun.write(join(dir, "README.md"), "# Root\n");
    await Bun.write(join(dir, "docs", "top.md"), "# Top\n");
    await Bun.write(
      join(dir, "docs", "integrations", "clipper.md"),
      "# Clipper\n"
    );
    await Bun.write(
      join(dir, "src", "converters", "registry.ts"),
      "export {};\n"
    );
    await Bun.write(join(dir, ".github", "workflows", "ci.yml"), "name: ci\n");
    await Bun.write(
      join(dir, ".github", ".secret", "hidden.yml"),
      "name: secret\n"
    );
    await Bun.write(join(dir, ".flow", "criteria.md"), "# Criteria\n");
    await Bun.write(join(dir, ".flow", "tasks", "task.md"), "# Task\n");
    await Bun.write(join(dir, ".agents", "skills", "SKILL.md"), "# Skill\n");

    // Partial exclusion `docs/*` must NOT prune `docs/integrations/clipper.md`.
    const partialDocs = await defaultWalker.walk({
      root: dir,
      pattern: "**/*.md",
      include: [".md"],
      exclude: ["docs/*"],
      maxBytes: 1024 * 1024,
    });
    expect(partialDocs.entries.map((e) => e.relPath)).toEqual([
      "docs/integrations/clipper.md",
      "README.md",
    ]);

    // Partial exclusion `src/converters*` must NOT prune `src/converters/registry.ts`.
    const partialPrefix = await defaultWalker.walk({
      root: dir,
      pattern: "src/**/*.ts",
      include: [".ts"],
      exclude: ["src/converters*"],
      maxBytes: 1024 * 1024,
    });
    expect(partialPrefix.entries.map((e) => e.relPath)).toEqual([
      "src/converters/registry.ts",
    ]);

    // Pattern `README.md` with exclude `src` must NOT emit a synthetic `src` EXCLUDED receipt.
    const singleFile = await defaultWalker.walk({
      root: dir,
      pattern: "README.md",
      include: [".md"],
      exclude: ["src"],
      maxBytes: 1024 * 1024,
    });
    expect(singleFile.entries.map((e) => e.relPath)).toEqual(["README.md"]);
    expect(singleFile.skipped).toEqual([]);

    // Union pattern with one explicit dot branch must NOT widen wildcard branch to other hidden dirs.
    const unionDot = await defaultWalker.walk({
      root: dir,
      pattern: "{.github/**/*.yml,**/*.md}",
      include: [".md", ".yml"],
      exclude: [],
      maxBytes: 1024 * 1024,
    });
    expect(unionDot.entries.map((e) => e.relPath)).toEqual([
      ".github/workflows/ci.yml",
      "docs/integrations/clipper.md",
      "docs/top.md",
      "README.md",
    ]);

    const exactDotFile = await defaultWalker.walk({
      root: dir,
      pattern: "{.flow/criteria.md,**/*.md}",
      include: [".md"],
      exclude: [],
      maxBytes: 1024 * 1024,
    });
    expect(exactDotFile.entries.map((e) => e.relPath)).toEqual([
      ".flow/criteria.md",
      "docs/integrations/clipper.md",
      "docs/top.md",
      "README.md",
    ]);

    // Slash-spanning brace patterns delegate to Bun.Glob.scan() for exact parity
    const slashBraceHidden = await defaultWalker.walk({
      root: dir,
      pattern: "**/{.github/workflows/*.yml,*.md}",
      include: [".md", ".yml"],
      exclude: [],
      maxBytes: 1024 * 1024,
    });
    expect(slashBraceHidden.entries).toEqual([]);

    const slashBraceOrdinary = await defaultWalker.walk({
      root: dir,
      pattern: "**/{src/converters/*.ts,README.md}",
      include: [".ts", ".md"],
      exclude: [],
      maxBytes: 1024 * 1024,
    });
    expect(slashBraceOrdinary.entries).toEqual([]);

    // local-mode walk preserves established directory exclusion semantics for `src/converters*`
    const localPartial = await defaultWalker.walk({
      root: dir,
      pattern: "src/**/*.ts",
      include: [".ts"],
      exclude: ["src/converters*"],
      maxBytes: 1024 * 1024,
      sourceAvailability: "local",
      directoryAvailability: {
        mode: "local",
        classify: () => Promise.resolve({ kind: "available" as const }),
        readDirectory: <T>(_path: string, read: () => T) => ({
          kind: "available" as const,
          value: read(),
        }),
      },
    });
    expect(localPartial.entries).toEqual([]);
  });

  test("rejects invalid glob patterns identically", async () => {
    const dir = await makeTempDir("gno-walk-invalid-");
    let errorMessage = "";
    try {
      await defaultWalker.walk({
        root: dir,
        pattern: "../escape/**/*",
        include: [],
        exclude: [],
        maxBytes: 1024 * 1024,
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(errorMessage).toContain("Invalid glob pattern");
  });
});

describe("R4: sync single-read, preloaded state, batching, and unchanged syncPaths fast-path", () => {
  test("preloads documents once, skips empty transactions on unchanged re-sync, and batches concurrency > 1", async () => {
    const dir = await makeTempDir("gno-sync-perf-");
    const dbPath = join(dir, "index.sqlite");
    const colDir = join(dir, "docs");
    await mkdir(colDir, { recursive: true });
    for (let i = 0; i < 6; i += 1) {
      await Bun.write(
        join(colDir, `doc-${i}.md`),
        `# Doc ${i}\n\nContent ${i}.\n`
      );
    }

    const store = new SqliteAdapter();
    await store.open(dbPath, "porter");
    const collection: Collection = {
      name: "docs",
      path: colDir,
      pattern: "**/*",
      include: [],
      exclude: [],
    };
    await store.syncCollections([collection]);

    let listDocsCalls = 0;
    let getDocCalls = 0;
    let listRecordCalls = 0;
    let topLevelTxCalls = 0;
    let txDepth = 0;
    let backlinkCalls = 0;

    const origListDocs = store.listDocuments.bind(store);
    const origGetDoc = store.getDocument.bind(store);
    const origListRec = store.listRecordDocuments.bind(store);
    const origTx = store.withTransaction.bind(store);
    const origBacklinks = store.getBacklinksForDoc.bind(store);

    store.listDocuments = (col?: string) => {
      listDocsCalls += 1;
      return origListDocs(col);
    };
    store.getDocument = (col: string, rel: string) => {
      getDocCalls += 1;
      return origGetDoc(col, rel);
    };
    store.listRecordDocuments = (col: string, src: string) => {
      listRecordCalls += 1;
      return origListRec(col, src);
    };
    store.withTransaction = async <T>(fn: () => Promise<T>) => {
      if (txDepth === 0) topLevelTxCalls += 1;
      txDepth += 1;
      try {
        return await origTx(fn);
      } finally {
        txDepth -= 1;
      }
    };
    store.getBacklinksForDoc = (id: number, opts?: { collection?: string }) => {
      backlinkCalls += 1;
      return origBacklinks(id, opts);
    };

    try {
      const sync = new SyncService();
      const first = await sync.syncCollection(collection, store, {
        concurrency: 3,
        projectTypedEdges: false,
      });
      expect(first.filesAdded).toBe(6);
      expect(first.files?.map((f) => f.relPath)).toEqual([
        "doc-0.md",
        "doc-1.md",
        "doc-2.md",
        "doc-3.md",
        "doc-4.md",
        "doc-5.md",
      ]);
      // Preloaded once in syncCollection: zero per-file getDocument/listRecordDocuments.
      expect(listDocsCalls).toBe(1);
      expect(getDocCalls).toBe(0);
      expect(listRecordCalls).toBe(0);
      // 1 prepareChunking tx + 1 batch tx for all 6 files (not 6 separate commits).
      expect(topLevelTxCalls).toBe(2);

      // Re-sync with zero changes: only prepareChunking tx runs, zero batch tx!
      listDocsCalls = 0;
      getDocCalls = 0;
      listRecordCalls = 0;
      topLevelTxCalls = 0;
      const second = await sync.syncCollection(collection, store, {
        concurrency: 3,
        projectTypedEdges: false,
      });
      expect(second.filesUnchanged).toBe(6);
      expect(listDocsCalls).toBe(1);
      expect(getDocCalls).toBe(0);
      expect(listRecordCalls).toBe(0);
      expect(topLevelTxCalls).toBe(1);

      // Updating all 6 files with concurrency > 1 commits in 1 prepareChunking + 1 batch tx.
      for (let i = 0; i < 6; i += 1) {
        await Bun.write(
          join(colDir, `doc-${i}.md`),
          `# Doc ${i}\n\nUpdated content ${i}.\n`
        );
      }
      topLevelTxCalls = 0;
      const third = await sync.syncCollection(collection, store, {
        concurrency: 3,
        projectTypedEdges: false,
      });
      expect(third.filesUpdated).toBe(6);
      expect(topLevelTxCalls).toBe(2);

      // syncPaths on unchanged file skips backlink & post-write queries.
      getDocCalls = 0;
      listRecordCalls = 0;
      backlinkCalls = 0;
      const single = await sync.syncPaths(collection, store, ["doc-0.md"], {
        projectTypedEdges: false,
      });
      expect(single.filesUnchanged).toBe(1);
      // Only 1 pre-check getDocument + 1 pre-check listRecordDocuments (passed into processFile, no post-write query).
      expect(getDocCalls).toBe(1);
      expect(listRecordCalls).toBe(1);
      expect(backlinkCalls).toBe(0);
    } finally {
      await store.close();
    }
  });

  test("isolates per-file store write failures inside a multi-file batch", async () => {
    const dir = await makeTempDir("gno-sync-isolate-");
    const dbPath = join(dir, "index.sqlite");
    const colDir = join(dir, "docs");
    await mkdir(colDir, { recursive: true });
    await Bun.write(join(colDir, "a-good.md"), "# Good\n\nValid body.\n");
    await Bun.write(join(colDir, "b-fail.md"), "# Fail\n\nFailing body.\n");

    const store = new SqliteAdapter();
    await store.open(dbPath, "porter");
    const collection: Collection = {
      name: "docs",
      path: colDir,
      pattern: "**/*",
      include: [],
      exclude: [],
    };
    await store.syncCollections([collection]);

    const origUpsertContent = store.upsertContent.bind(store);
    store.upsertContent = (hash: string, md: string) => {
      if (md.includes("Failing body")) {
        return Promise.resolve(err("QUERY_FAILED", "injected failure"));
      }
      return origUpsertContent(hash, md);
    };

    try {
      const result = await new SyncService().syncCollection(collection, store, {
        projectTypedEdges: false,
      });
      expect(result.filesAdded).toBe(1);
      expect(result.filesErrored).toBe(1);
      const good = await store.getDocument("docs", "a-good.md");
      const failed = await store.getDocument("docs", "b-fail.md");
      expect(good.ok && good.value?.mirrorHash).toBeTruthy();
      expect(failed.ok && failed.value).toBeNull();
    } finally {
      await store.close();
    }
  });

  test("syncPaths collects pre-write backlinks before persisting changed documents", async () => {
    const dir = await makeTempDir("gno-sync-prewrite-");
    const dbPath = join(dir, "index.sqlite");
    const colDir = join(dir, "docs");
    await mkdir(colDir, { recursive: true });
    await Bun.write(join(colDir, "note.md"), "# Original Title\n\nBody v1.\n");

    const store = new SqliteAdapter();
    await store.open(dbPath, "porter");
    const collection: Collection = {
      name: "docs",
      path: colDir,
      pattern: "**/*",
      include: [],
      exclude: [],
    };
    await store.syncCollections([collection]);

    try {
      const sync = new SyncService();
      await sync.syncCollection(collection, store, {
        projectTypedEdges: false,
      });
      const before = await store.getDocument("docs", "note.md");
      expect(before.ok && before.value?.title).toBe("Original Title");

      // Edit file and fail getBacklinksForDoc: update MUST NOT be committed.
      await Bun.write(
        join(colDir, "note.md"),
        "# Replaced Title\n\nBody v2.\n"
      );
      store.getBacklinksForDoc = () =>
        Promise.resolve(err("QUERY_FAILED", "injected backlink failure"));
      const res = await sync.syncPaths(collection, store, ["note.md"], {
        projectTypedEdges: false,
      });
      expect(res.files?.[0]?.status).toBe("error");
      expect(res.files?.[0]?.errorCode).toBe("QUERY_FAILED");

      const after = await store.getDocument("docs", "note.md");
      expect(after.ok && after.value?.title).toBe("Original Title");
      expect(after.ok && after.value?.sourceHash).toBe(
        before.ok ? before.value?.sourceHash : undefined
      );
    } finally {
      await store.close();
    }
  });
});

describe("R5: single-pass Markdown, chunking, language detection, canonicalization", () => {
  test("frontmatter, line offsets, excluded ranges, chunker, language, and canonicalize preserve exact parity", async () => {
    // 10-line Logseq window vs line 11
    const logseqInWindow = `${"\n".repeat(9)}tags:: alpha, #beta\nBody`;
    const logseqPastWindow = `${"\n".repeat(10)}tags:: alpha, #beta\nBody`;
    expect(parseFrontmatter(logseqInWindow).tags).toEqual(["alpha", "beta"]);
    expect(parseFrontmatter(logseqPastWindow).tags).toEqual([]);

    const fmDoc = "---\ntitle: Hello\ntags: [One, Two]\n---\n\n# Heading\n";
    const details = parseFrontmatterDetails(fmDoc);
    expect(details.tags).toEqual(["one", "two"]);
    expect(details.metadata.title).toBe("Hello");
    expect(fmDoc.slice(details.bodyStart)).toBe("\n# Heading\n");

    // Line offsets
    expect(buildLineOffsets("")).toEqual([0]);
    expect(buildLineOffsets("abc\ndef\nghi")).toEqual([0, 4, 8]);
    expect(buildLineOffsets("a\r\nb\n")).toEqual([0, 3, 5]);

    // Excluded ranges with code + oversized table
    const withCode = "intro `code` mid\n\n    indented\n\n<!-- comment -->\n";
    const ranges = getExcludedRanges(withCode);
    expect(ranges.map((r) => r.kind)).toEqual([
      "inline_code",
      "indented_code",
      "html_comment",
    ]);
    const bigTable = `${"|a|b|c|d|e|\n".repeat(Math.ceil(MAX_PARSED_TABLE_CELLS / 5) + 5)}\n\`x\`\n`;
    expect(
      getExcludedRanges(bigTable).some((r) => r.kind === "inline_code")
    ).toBe(true);

    // Code chunking breakpoints (binary search + combined regex)
    const tsSource = Array.from(
      { length: 40 },
      (_, idx) =>
        `export function fn${idx}(value: number): number {\n  return value + ${idx};\n}\n`
    ).join("\n");
    const chunks = defaultChunker.chunk(
      tsSource,
      { maxTokens: 80, overlapPercent: 0.15 },
      undefined,
      "src/sample.ts"
    );
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[1]?.text.trimStart().startsWith("export function ")).toBe(
      true
    );
    expect(defaultChunker.chunk("   \n\t  ")).toEqual([]);

    // Overlapping multiline code breakpoints match independent pattern scans identically
    const exportMultiline =
      "// aaaaaaaaaaaaaaaaa\nexport default\nclass Foo {}\n" +
      "// filler line to force multiple chunks\n".repeat(4);
    const exportChunks = defaultChunker.chunk(
      exportMultiline,
      { maxTokens: 10, overlapPercent: 0 },
      undefined,
      "src/overlap.ts"
    );
    expect(exportChunks[0]?.text.length).toBe(36);

    const arrowWithNestedClass =
      "// header line padding text!\nconst f = (arg =\nclass Inner {}\n) => {\n  return 1;\n};\n" +
      "// trailing comment line\n".repeat(4);
    const arrowChunks = defaultChunker.chunk(
      arrowWithNestedClass,
      { maxTokens: 12, overlapPercent: 0 },
      undefined,
      "src/arrow.ts"
    );
    expect(arrowChunks[0]?.text.length).toBe(46);
    expect(arrowChunks[0]?.text).not.toContain("class Inner");
    expect(arrowChunks[1]?.text.startsWith("class Inner")).toBe(true);

    // U+2028 separator and `export\nclass` match exact base chunk boundaries
    const lsExport =
      "// aaaaaaaaaaaaaaaaaaaaaaaaa\nexport default\u2028class Foo {}\n" +
      "// filler\n".repeat(6);
    const lsChunks = defaultChunker.chunk(
      lsExport,
      { maxTokens: 12, overlapPercent: 0 },
      undefined,
      "src/ls.ts"
    );
    expect(lsChunks[0]?.text.length).toBe(44);

    const exportThenClass =
      "// aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nexport\nclass FooBarBazQux {}\n" +
      "// filler\n".repeat(6);
    const exportThenClassChunks = defaultChunker.chunk(
      exportThenClass,
      { maxTokens: 12, overlapPercent: 0 },
      undefined,
      "src/export-class.ts"
    );
    // No spurious breakpoint at `class`: prose break occurs at `export\n` (45) or word boundary (51),
    // matching exact independent-regex base behavior (offset 45 via single newline, not structural).
    expect(exportThenClassChunks[0]?.text.length).toBe(45);

    // Language detection (ASCII/Latin/CJK + surrogate pairs)
    expect(
      defaultLanguageDetector.detect(
        "The quick brown fox and the lazy dog have been running with this test for a while."
      )
    ).toBe("en");
    expect(
      defaultLanguageDetector.detect(
        "Der schnelle braune Fuchs und die Katze sind mit dem Hund auf dem Weg nicht allein."
      )
    ).toBe("de");
    expect(
      defaultLanguageDetector.detect(
        "こんにちは世界、これは日本語のテスト文章です。ひらがなとカタカナを含みます。テストテストテスト。追加の文字を入れて五十文字以上にします。"
      )
    ).toBe("ja");
    expect(
      defaultLanguageDetector.detect(
        "안녕하세요 세계 이것은 한국어 테스트 문장입니다 한글 문자가 충분히 많이 포함되어 있습니다."
      )
    ).toBe("ko");
    expect(
      defaultLanguageDetector.detect(
        "这是一个中文测试文档，包含足够多的汉字内容，用于验证语言检测算法的准确性与一致性，确保字符长度超过五十个字符的检测阈值要求。"
      )
    ).toBe("zh");
    // Surrogate pairs (emoji) must not trigger false CJK
    expect(
      defaultLanguageDetector.detect(
        `🚀🎉 ${"The quick brown fox and the dog are with this test ".repeat(2)}`
      )
    ).toBe("en");

    // Canonicalize: pure ASCII fast path vs CR vs NFD non-ASCII
    expect(canonicalize("hello\n\n\nworld  \n")).toBe("hello\n\nworld\n");
    expect(canonicalize("\uFEFFa\r\nb\rc\x00d\n")).toBe("a\nb\ncd\n");
    const nfd = "Cafe\u0301\n";
    const nfc = "Caf\u00e9\n";
    expect(canonicalize(nfd)).toBe(nfc);
    expect(mirrorHash(canonicalize(nfd))).toBe(mirrorHash(canonicalize(nfc)));

    // Native converters: heading skips fenced block & BOM stripped
    const mdConv = await markdownConverter.convert({
      sourcePath: "/tmp/h.md",
      relativePath: "h.md",
      collection: "notes",
      bytes: new TextEncoder().encode(
        "\uFEFF```\n# Not Heading\n```\n\n# Real Title\nBody"
      ),
      mime: "text/markdown",
      ext: ".md",
      limits: { maxBytes: 1024, timeoutMs: 5000, maxOutputChars: 1024 },
    });
    expect(mdConv.ok && mdConv.value.title).toBe("Real Title");

    const txtConv = await plaintextConverter.convert({
      sourcePath: "/tmp/p.txt",
      relativePath: "p.txt",
      collection: "notes",
      bytes: new TextEncoder().encode("\uFEFFPlain text"),
      mime: "text/plain",
      ext: ".txt",
      limits: { maxBytes: 1024, timeoutMs: 5000, maxOutputChars: 1024 },
    });
    expect(txtConv.ok && txtConv.value.markdown).toBe("Plain text");
  });
});

describe("R6: converter and record-container hot loops", () => {
  test("utf8-lines handles multi-chunk boundaries, BOM, CRLF, and invalid UTF-8 isolation", async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62]);
      yield new Uint8Array([0x0d, 0x0a, 0xff, 0xfe, 0x0a, 0x6f, 0x6b]);
    }
    const lines = [];
    for await (const line of readBoundedUtf8Lines(chunks(), 64)) {
      lines.push(line);
    }
    expect(lines).toEqual([
      { ok: true, lineNumber: 1, text: "ab", terminated: true },
      { ok: false, lineNumber: 2, reason: "invalid_utf8", terminated: true },
      { ok: true, lineNumber: 3, text: "ok", terminated: false },
    ]);
  });

  test("ooxml-protection detects CFB encrypted markers using Buffer.indexOf", () => {
    const header = new Uint8Array([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
    ]);
    const info = utf16le("EncryptionInfo");
    const pkg = utf16le("EncryptedPackage");
    const combined = new Uint8Array(
      header.length + 16 + info.length + 16 + pkg.length
    );
    combined.set(header, 0);
    combined.set(info, header.length + 16);
    combined.set(pkg, header.length + 16 + info.length + 16);
    expect(isPasswordProtectedXlsx(combined)).toBe(true);
    expect(includesBytes(combined, utf16le("NotPresent"))).toBe(false);
    expect(
      isPasswordProtectedXlsx(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
    ).toBe(false);
  });

  test("ical, email, browser-export, html-text, and shared record-adapter deadline timer", async () => {
    // Malformed HTML tail stays strictly linear
    const t0 = performance.now();
    expect(htmlFragmentToText("&".repeat(200_000))).toHaveLength(200_000);
    expect(htmlFragmentToText("<".repeat(200_000))).toHaveLength(200_000);
    expect(performance.now() - t0).toBeLessThan(2_000);

    // iCalendar multi-event stream with cursor parsing
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:ev-1",
      "DTSTART:20260501T100000Z",
      "SUMMARY:Standup",
      "DESCRIPTION:Line one",
      "  continued",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const icsRun = await runRecordAdapter(icalAdapter, {
      sourcePath: "/tmp/cal.ics",
      relativePath: "cal.ics",
      collection: "cal",
      mime: "text/calendar",
      ext: ".ics",
      open: () => ({
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode(ics);
        },
      }),
      limits: {
        maxSourceBytes: 1024 * 1024,
        maxRecords: 100,
        maxRecordChars: 65_536,
        maxMetadataChars: 16_384,
        maxTotalChars: 1024 * 1024,
        maxFailures: 50,
        timeoutMs: 10_000,
      },
    });
    expect(icsRun.authoritative).toBe(true);
    expect(icsRun.records).toHaveLength(1);
    expect(icsRun.records[0]?.adapterFingerprint).toBe(
      recordAdapterFingerprint(icalAdapter)
    );
    expect(icsRun.records[0]?.markdown).toContain("Line one continued");

    // Email adapter (multipart + quoted-printable + HTML sanitization)
    const eml = [
      "From: Alice <alice@example.com>",
      "Subject: Hello",
      "Message-ID: <m1@example.com>",
      "Date: Fri, 01 May 2026 10:00:00 +0000",
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "<html><body><script>bad()</script><p>Hi=20there &amp; welcome</p></body></html>",
    ].join("\r\n");
    const emlRun = await runRecordAdapter(emailRecordAdapter, {
      sourcePath: "/tmp/a.eml",
      relativePath: "a.eml",
      collection: "mail",
      mime: "message/rfc822",
      ext: ".eml",
      open: () => ({
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode(eml);
        },
      }),
      limits: {
        maxSourceBytes: 1024 * 1024,
        maxRecords: 100,
        maxRecordChars: 65_536,
        maxMetadataChars: 16_384,
        maxTotalChars: 1024 * 1024,
        maxFailures: 50,
        timeoutMs: 10_000,
      },
    });
    expect(emlRun.authoritative).toBe(true);
    expect(emlRun.records[0]?.markdown).toContain("Hi there & welcome");
    expect(emlRun.records[0]?.markdown).not.toContain("bad()");

    // Browser export Netscape single-pass structure check
    const bookmarks =
      '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><H3>Work</H3><DL><DT><A HREF="https://example.com" ADD_DATE="1700000000">Example</A></DL></DL>';
    const bmRun = await runRecordAdapter(browserExportAdapter, {
      sourcePath: "/tmp/bm.html",
      relativePath: "bm.html",
      collection: "web",
      mime: "text/x-gno-browser-bookmarks+html",
      ext: ".html",
      open: () => ({
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode(bookmarks);
        },
      }),
      limits: {
        maxSourceBytes: 1024 * 1024,
        maxRecords: 100,
        maxRecordChars: 65_536,
        maxMetadataChars: 16_384,
        maxTotalChars: 1024 * 1024,
        maxFailures: 50,
        timeoutMs: 10_000,
      },
    });
    expect(bmRun.authoritative).toBe(true);
    expect(bmRun.records).toHaveLength(1);

    // Malformed Netscape exports with embedded tag markers stay non-authoritative
    for (const malformedHtml of [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL data="<A>"></DL>',
      '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://example.com" TITLE="</H3>">Example</A></DL>',
    ]) {
      const badBm = await runRecordAdapter(browserExportAdapter, {
        sourcePath: "/tmp/bad-bm.html",
        relativePath: "bad-bm.html",
        collection: "web",
        mime: "text/x-gno-browser-bookmarks+html",
        ext: ".html",
        open: () => ({
          async *[Symbol.asyncIterator]() {
            yield new TextEncoder().encode(malformedHtml);
          },
        }),
        limits: {
          maxSourceBytes: 1024 * 1024,
          maxRecords: 100,
          maxRecordChars: 65_536,
          maxMetadataChars: 16_384,
          maxTotalChars: 1024 * 1024,
          maxFailures: 50,
          timeoutMs: 10_000,
        },
      });
      expect(badBm.authoritative).toBe(false);
    }

    // Valid bookmark export with stray text before closing </DL> still imports
    const strayClose =
      '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://example.com">Example</A></DL junk </DL>';
    const strayRun = await runRecordAdapter(browserExportAdapter, {
      sourcePath: "/tmp/stray-bm.html",
      relativePath: "stray-bm.html",
      collection: "web",
      mime: "text/x-gno-browser-bookmarks+html",
      ext: ".html",
      open: () => ({
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode(strayClose);
        },
      }),
      limits: {
        maxSourceBytes: 1024 * 1024,
        maxRecords: 100,
        maxRecordChars: 65_536,
        maxMetadataChars: 16_384,
        maxTotalChars: 1024 * 1024,
        maxFailures: 50,
        timeoutMs: 10_000,
      },
    });
    expect(strayRun.authoritative).toBe(true);
    expect(strayRun.records).toHaveLength(1);

    // Synchronous adapter exceeding deadline before yielding complete still returns TIMEOUT
    const syncHogAdapter: RecordAdapter = {
      id: "test/sync-hog",
      version: "1.0.0",
      canHandle: () => true,
      async *records(): AsyncGenerator<RecordAdapterEvent> {
        const until = Date.now() + 40;
        while (Date.now() < until) {
          // intentional synchronous spin
        }
        yield { type: "snapshot", state: "complete" };
      },
    };
    const syncTimedOut = await runRecordAdapter(syncHogAdapter, {
      sourcePath: "/tmp/hog.dat",
      relativePath: "hog.dat",
      collection: "test",
      mime: "application/octet-stream",
      ext: ".dat",
      open: () => ({
        async *[Symbol.asyncIterator]() {
          // empty
        },
      }),
      limits: {
        maxSourceBytes: 1024,
        maxRecords: 10,
        maxRecordChars: 1024,
        maxMetadataChars: 1024,
        maxTotalChars: 10_000,
        maxFailures: 10,
        timeoutMs: 5,
      },
    });
    expect(syncTimedOut.authoritative).toBe(false);
    expect(syncTimedOut.failures.some((f) => f.code === "TIMEOUT")).toBe(true);

    // Shared deadline timer fires TIMEOUT on slow adapter
    const slowAdapter: RecordAdapter = {
      id: "test/slow",
      version: "1.0.0",
      canHandle: () => true,
      async *records(): AsyncGenerator<RecordAdapterEvent> {
        await Bun.sleep(200);
        yield { type: "snapshot", state: "complete" };
      },
    };
    const timedOut = await runRecordAdapter(slowAdapter, {
      sourcePath: "/tmp/slow.dat",
      relativePath: "slow.dat",
      collection: "test",
      mime: "application/octet-stream",
      ext: ".dat",
      open: () => ({
        async *[Symbol.asyncIterator]() {
          // empty
        },
      }),
      limits: {
        maxSourceBytes: 1024,
        maxRecords: 10,
        maxRecordChars: 1024,
        maxMetadataChars: 1024,
        maxTotalChars: 10_000,
        maxFailures: 10,
        timeoutMs: 25,
      },
    });
    expect(timedOut.stoppedByCap).toBe(true);
    expect(timedOut.failures.some((f) => f.code === "TIMEOUT")).toBe(true);
  });
});

describe("R7: incremental graph reconciliation", () => {
  test("skips incomingLinkSources and listDocuments on body-only edits, runs on title change", async () => {
    const dir = await makeTempDir("gno-graph-perf-");
    const dbPath = join(dir, "index.sqlite");
    const colDir = join(dir, "notes");
    await mkdir(colDir, { recursive: true });
    await Bun.write(join(colDir, "target.md"), "# Target\n\nInitial body.\n");
    await Bun.write(
      join(colDir, "source.md"),
      "# Source\n\nLinks to [[Target]].\n"
    );

    const store = new SqliteAdapter();
    await store.open(dbPath, "porter");
    const collection: Collection = {
      name: "notes",
      path: colDir,
      pattern: "**/*",
      include: [],
      exclude: [],
    };
    await store.syncCollections([collection]);

    try {
      const sync = new SyncService();
      await sync.syncCollection(collection, store);

      // Spy on listDocuments, listGraphDocumentIdentities, and incomingLinkSources
      let listDocsCalls = 0;
      let listIdentitiesCalls = 0;
      let incomingLinkCalls = 0;
      const origListDocs = store.listDocuments.bind(store);
      const origListIds = store.listGraphDocumentIdentities.bind(store);
      const origGraphStore = store.graphReferenceStore.bind(store);

      const spiedStore: StorePort = Object.assign(
        Object.create(Object.getPrototypeOf(store)),
        store,
        {
          listDocuments: (col?: string) => {
            listDocsCalls += 1;
            return origListDocs(col);
          },
          listGraphDocumentIdentities: () => {
            listIdentitiesCalls += 1;
            return origListIds();
          },
          graphReferenceStore: () => {
            const inner = origGraphStore();
            return {
              ...inner,
              incomingLinkSources: (
                identities: Parameters<typeof inner.incomingLinkSources>[0]
              ) => {
                incomingLinkCalls += 1;
                return inner.incomingLinkSources(identities);
              },
            };
          },
        }
      );

      // 1. Body-only edit on target.md (title stays "# Target"):
      await Bun.write(
        join(colDir, "target.md"),
        "# Target\n\nUpdated body only.\n"
      );
      await sync.syncPaths(collection, store, ["target.md"], {
        projectTypedEdges: false,
      });
      const bodyErrors = await projectGraph(spiedStore, {});
      expect(bodyErrors).toEqual([]);
      expect(listIdentitiesCalls).toBe(1);
      expect(listDocsCalls).toBe(0);
      expect(incomingLinkCalls).toBe(0);

      // 2. Title edit on target.md (addressable field changed!):
      listDocsCalls = 0;
      listIdentitiesCalls = 0;
      incomingLinkCalls = 0;
      await Bun.write(
        join(colDir, "target.md"),
        "# Renamed Target\n\nUpdated title.\n"
      );
      await sync.syncPaths(collection, store, ["target.md"], {
        projectTypedEdges: false,
      });
      const titleErrors = await projectGraph(spiedStore, {});
      expect(titleErrors).toEqual([]);
      expect(listIdentitiesCalls).toBe(1);
      expect(listDocsCalls).toBe(0);
      expect(incomingLinkCalls).toBeGreaterThan(0);

      // Verify source.md's edge to [[Target]] was updated/cleared after rename
      const sourceDoc = await store.getDocument("notes", "source.md");
      expect(sourceDoc.ok && sourceDoc.value).toBeTruthy();
      if (sourceDoc.ok && sourceDoc.value) {
        const edges = await store.getEdgesForDoc(sourceDoc.value.id);
        expect(edges.ok).toBe(true);
        // [[Target]] still resolves via filename stem `target`!
        expect(edges.ok && edges.value.length).toBe(1);
      }

      // 3. Duplicate content-type rule IDs preserve first-rule precedence:
      //    first rule has no graph hint, second rule has `depends_on` -> default backfill wins.
      await Bun.write(
        join(colDir, "memo.md"),
        "---\ntype: memo\n---\n# Memo\n\nSee [[Renamed Target]].\n"
      );
      await sync.syncPaths(collection, store, ["memo.md"], {
        contentTypeRules: normalizeContentTypes([
          { id: "memo", preset: "note", prefixes: ["a/"], graphHints: [] },
          {
            id: "memo",
            preset: "note",
            prefixes: ["b/"],
            graphHints: ["depends_on"],
          },
        ]).rules,
      });
      const memoDoc = await store.getDocument("notes", "memo.md");
      expect(memoDoc.ok && memoDoc.value).toBeTruthy();
      if (memoDoc.ok && memoDoc.value) {
        const memoEdges = await store.getEdgesForDoc(memoDoc.value.id);
        expect(memoEdges.ok).toBe(true);
        if (memoEdges.ok) {
          expect(memoEdges.value.some((e) => e.edgeType === "depends_on")).toBe(
            false
          );
          expect(memoEdges.value.length).toBe(1);
        }
      }
    } finally {
      await store.close();
    }
  });
});
