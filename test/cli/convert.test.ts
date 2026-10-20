/**
 * gno convert (fn-223): one file to the Markdown indexing would store, with
 * nothing persisted. Parity is checked against the mirror a real sync writes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for temp fixtures (no Bun equivalent for mkdtemp/symlink/truncate/chmod)
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  symlink,
  truncate,
} from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Collection } from "../../src/config/types";

import { runCli } from "../../src/cli/run";
import { DEFAULT_LIMITS } from "../../src/converters/types";
import { SyncService } from "../../src/ingestion";
import { convertFile, GnoSdkError } from "../../src/sdk";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const FIXTURES = join(import.meta.dir, "../fixtures");
// One file per single-document converter: Markdown, plain text, PDF and
// DOCX (markitdown), PPTX (officeparser) and XLSX.
const PARITY_FILES = [
  ["note.md", null],
  ["notes.txt", null],
  ["sample.pdf", "conversion/pdf/sample.pdf"],
  ["sample.docx", "conversion/docx/sample.docx"],
  ["sample.pptx", "conversion/pptx/sample.pptx"],
  ["sample.xlsx", "conversion/xlsx/sample.xlsx"],
] as const;
const SLOW_TEST_MS = 60_000;

let stdoutData = "";
let stderrData = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  stdoutData = "";
  stderrData = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  try {
    const code = await runCli(["node", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

const errorReason = (stderr: string): unknown =>
  (JSON.parse(stderr) as { error: { details?: { reason?: unknown } } }).error
    .details?.reason;

async function treeSnapshot(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true })) {
    const path = join(root, entry);
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    snapshot[entry] = new Bun.CryptoHasher("sha256")
      .update(await file.bytes())
      .digest("hex");
  }
  return snapshot;
}

let testDir: string;
let root: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "gno-convert-"));
  root = join(testDir, "files");
  await mkdir(root);
  await Bun.write(
    join(root, "note.md"),
    "# Field notes\n\nSee [the plan](plan.md) and [[Roadmap]].\n\n```ts\nconst x = 1;\n```\n"
  );
  await Bun.write(join(root, "notes.txt"), "Plain text\r\nwith CRLF lines\n");
  for (const [name, fixture] of PARITY_FILES) {
    if (fixture) await copyFile(join(FIXTURES, fixture), join(root, name));
  }
  // Isolate every GNO directory: convert must not need or touch them.
  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");
});

afterAll(async () => {
  Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
  Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
  Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
  await safeRm(testDir);
});

describe("gno convert", () => {
  test(
    "R1: Markdown and mirrorHash equal the mirror a sync stores, per converter",
    async () => {
      const store = new SqliteAdapter();
      expect(
        (await store.open(join(testDir, "parity.sqlite"), "porter")).ok
      ).toBe(true);
      const collection: Collection = {
        name: "files",
        path: root,
        pattern: "**/*",
        include: [],
        exclude: [],
      };
      try {
        await store.syncCollections([collection]);
        await new SyncService().syncCollection(collection, store);
        const converters = new Set<string>();
        for (const [name] of PARITY_FILES) {
          const doc = await store.getDocument("files", name);
          if (!doc.ok || !doc.value?.mirrorHash) {
            throw new Error(`${name} was not indexed`);
          }
          const stored = await store.getContent(doc.value.mirrorHash);
          if (!stored.ok || stored.value === null) {
            throw new Error(`${name} has no stored mirror`);
          }

          const result = await cli("convert", join(root, name), "--json");
          expect(result.code).toBe(0);
          const converted = JSON.parse(result.stdout) as {
            markdown: string;
            mirrorHash: string;
            converter: { id: string };
          };
          expect(converted.mirrorHash).toBe(doc.value.mirrorHash);
          expect(converted.markdown).toBe(stored.value);
          converters.add(converted.converter.id);

          // Terminal output is exactly the Markdown.
          const plain = await cli("convert", join(root, name));
          expect(plain.code).toBe(0);
          expect(plain.stdout).toBe(stored.value);
        }
        // The fixtures cover every single-document converter in the registry.
        expect(converters.size).toBe(5);
      } finally {
        await store.close();
      }
    },
    SLOW_TEST_MS
  );

  test(
    "R2: works without config and leaves an existing data directory untouched",
    async () => {
      const dirs = [
        process.env.GNO_CONFIG_DIR,
        process.env.GNO_DATA_DIR,
        process.env.GNO_CACHE_DIR,
      ] as string[];
      const noConfig = await cli("convert", join(root, "note.md"));
      expect(noConfig.code).toBe(0);
      for (const dir of dirs) expect(await Bun.file(dir).exists()).toBe(false);

      const init = await cli("init", root, "--name", "files");
      expect(init.code).toBe(0);
      const update = await cli("update");
      expect(update.code).toBe(0);
      const before = await Promise.all(dirs.map((dir) => treeSnapshot(dir)));
      const converted = await cli("convert", join(root, "sample.pdf"));
      expect(converted.code).toBe(0);
      const after = await Promise.all(dirs.map((dir) => treeSnapshot(dir)));
      expect(after).toEqual(before);
    },
    SLOW_TEST_MS
  );

  test("R3: --json validates against convert@1.0", async () => {
    const schema = await loadSchema("convert");
    const result = await cli("convert", join(root, "sample.pptx"), "--json");
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(assertValid(output, schema)).toBe(true);
    expect(Object.keys(output).sort()).toEqual(
      [
        "converter",
        "languageHint",
        "markdown",
        "mirrorHash",
        "schemaVersion",
        "source",
        "title",
        "warnings",
      ].sort()
    );
    expect(output.source).toEqual({
      path: join(root, "sample.pptx"),
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ext: ".pptx",
      sizeBytes: Bun.file(join(root, "sample.pptx")).size,
    });
  });

  test("R4: each failure has its reason and exit code", async () => {
    await Bun.write(join(testDir, "data.unknownext"), "binary-ish");
    const cases = [
      [join(testDir, "missing.md"), "NOT_FOUND", 1],
      [root, "NOT_FOUND", 1],
      [join(testDir, "data.unknownext"), "UNSUPPORTED", 1],
      [join(FIXTURES, "conversion/pdf/corrupt.pdf"), "CORRUPT", 2],
      [
        join(FIXTURES, "conversion/pdf/password-protected.pdf"),
        "PERMISSION",
        2,
      ],
    ] as const;
    for (const [path, reason, exit] of cases) {
      const result = await cli("convert", path, "--json");
      expect({
        path,
        code: result.code,
        reason: errorReason(result.stderr),
      }).toEqual({ path, code: exit, reason });
    }
  });

  test(
    "R4: a file over the indexing size limit is refused without being read",
    async () => {
      const big = join(testDir, "huge.md");
      await Bun.write(big, "");
      await truncate(big, DEFAULT_LIMITS.maxBytes + 1);
      // Unreadable on POSIX: a read would fail with a different error.
      if (process.platform !== "win32") await chmod(big, 0o000);
      try {
        const result = await cli("convert", big, "--json");
        expect(result.code).toBe(1);
        expect(errorReason(result.stderr)).toBe("TOO_LARGE");
      } finally {
        await chmod(big, 0o644).catch(() => undefined);
      }
    },
    SLOW_TEST_MS
  );

  test.skipIf(process.platform === "win32")(
    "R4: symlinks follow their target; a link to a directory is NOT_FOUND",
    async () => {
      await symlink(join(root, "note.md"), join(testDir, "link.md"));
      await symlink(root, join(testDir, "link-dir"));
      const toFile = await cli("convert", join(testDir, "link.md"));
      expect(toFile.code).toBe(0);
      expect(toFile.stdout).toStartWith("# Field notes");
      const toDir = await cli("convert", join(testDir, "link-dir"), "--json");
      expect(toDir.code).toBe(1);
      expect(errorReason(toDir.stderr)).toBe("NOT_FOUND");
    }
  );

  test.skipIf(process.platform === "win32")(
    "R4: an unreadable file fails with PERMISSION on the CLI and in the SDK",
    async () => {
      const locked = join(testDir, "locked.md");
      await Bun.write(locked, "# Locked\n");
      await chmod(locked, 0o000);
      try {
        const result = await cli("convert", locked, "--json");
        expect(result.code).toBe(2);
        expect(errorReason(result.stderr)).toBe("PERMISSION");
        const error = await convertFile(locked).then(
          () => null,
          (cause: unknown) => cause
        );
        expect(error).toBeInstanceOf(GnoSdkError);
        expect((error as GnoSdkError).details?.reason).toBe("PERMISSION");
      } finally {
        await chmod(locked, 0o644);
      }
    }
  );

  test("R5: multi-record formats are refused with no partial output", async () => {
    for (const [fixture, format] of [
      ["exports/mail/mixed.mbox", "native/email-export"],
      ["exports/calendar/sample.ics", "adapter/ical-export"],
    ] as const) {
      const plain = await cli("convert", join(FIXTURES, fixture));
      expect(plain.code).toBe(1);
      expect(plain.stdout).toBe("");
      expect(plain.stderr).toContain(format);

      const json = await cli("convert", join(FIXTURES, fixture), "--json");
      const { error } = JSON.parse(json.stderr) as {
        error: { code: string; details: Record<string, unknown> };
      };
      expect(error.code).toBe("VALIDATION");
      expect(error.details).toEqual({ reason: "MULTI_DOCUMENT", format });
    }
  });

  test("R6: SDK convertFile returns the --json object and typed errors", async () => {
    const path = join(root, "sample.docx");
    const cliResult = await cli("convert", path, "--json");
    expect(await convertFile(path)).toEqual(JSON.parse(cliResult.stdout));

    for (const [file, code, reason] of [
      [join(testDir, "missing.md"), "NOT_FOUND", "NOT_FOUND"],
      [
        join(FIXTURES, "exports/mail/mixed.mbox"),
        "VALIDATION",
        "MULTI_DOCUMENT",
      ],
      [join(FIXTURES, "conversion/pdf/corrupt.pdf"), "RUNTIME", "CORRUPT"],
    ] as const) {
      const error = await convertFile(file).then(
        () => null,
        (cause: unknown) => cause
      );
      expect(error).toBeInstanceOf(GnoSdkError);
      expect({
        code: (error as GnoSdkError).code,
        reason: (error as GnoSdkError).details?.reason,
      }).toEqual({ code, reason });
    }
  });
});
