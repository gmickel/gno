/**
 * gno ls --filter and SDK list({ filter }): typed metadata listing.
 */

import { createDefaultConfig, createGnoClient } from "@gmickel/gno";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const DRAFTS = 30;
const DRAFT = '{"op":"eq","key":"status","value":"draft"}';
const NOT_DRAFT =
  '{"op":"not","predicate":{"op":"eq","key":"status","value":"draft"}}';

let testDir: string;
let docsDir: string;
let stdoutData = "";
let stderrData = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

async function cli(...args: string[]) {
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
  console.log = (...parts: unknown[]) => {
    stdoutData += `${parts.join(" ")}\n`;
  };
  console.error = (...parts: unknown[]) => {
    stderrData += `${parts.join(" ")}\n`;
  };
  try {
    const code = await runCli(["node", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }
}

const note = (status: string, title: string) =>
  `---\ntitle: ${title}\ngno:\n  metadata:\n    status: ${status}\n    project: [atlas]\n---\n\n# ${title}\n`;

interface LsJson {
  documents: Array<{ docid: string; uri: string }>;
  meta: {
    total: number;
    returned: number;
    offset: number;
    warnings?: Array<{ code: string; message: string }>;
  };
}

const lsJson = async (...args: string[]): Promise<LsJson> => {
  const result = await cli("ls", ...args, "--json");
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as LsJson;
};

beforeAll(async () => {
  testDir = join(tmpdir(), `gno-ls-filter-${Date.now()}`);
  docsDir = join(testDir, "docs");
  await mkdir(join(docsDir, "drafts"), { recursive: true });
  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");
  for (let index = 0; index < DRAFTS; index += 1) {
    const name = `d${String(index).padStart(2, "0")}`;
    await writeFile(join(docsDir, "drafts", `${name}.md`), note("draft", name));
  }
  await writeFile(join(docsDir, "a1.md"), note("approved", "a1"));
  await writeFile(join(docsDir, "a2.md"), note("approved", "a2"));
  await writeFile(join(docsDir, "plain.md"), "# Plain\n");
  // A null value is invalid typed metadata.
  await writeFile(
    join(docsDir, "broken.md"),
    "---\ngno:\n  metadata:\n    status: null\n---\n\n# Broken\n"
  );
  expect((await cli("init", docsDir, "--name", "work")).code).toBe(0);
  expect((await cli("update")).code).toBe(0);
}, 60_000);

afterAll(async () => {
  await safeRm(testDir);
  Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
  Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
  Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
});

describe("gno ls --filter", () => {
  test("lists exactly the matching documents, paginated over matches only", async () => {
    const all = await lsJson("--filter", DRAFT, "-n", "100");
    expect(all.meta.total).toBe(DRAFTS);
    expect(all.documents.every((d) => d.uri.includes("/drafts/"))).toBe(true);

    const page = await lsJson("--filter", DRAFT, "-n", "10", "--offset", "20");
    expect(page.meta).toMatchObject({
      total: DRAFTS,
      returned: 10,
      offset: 20,
    });
    expect(page.documents.map((d) => d.uri)).toEqual(
      all.documents.slice(20).map((d) => d.uri)
    );
  });

  test("combines with the scope argument", async () => {
    const scoped = await lsJson("gno://work/drafts/", "--filter", NOT_DRAFT);
    expect(scoped.meta.total).toBe(0);
    const approved = await lsJson("work", "--filter", NOT_DRAFT);
    // plain.md has a valid empty map, so not(eq) matches it; broken.md never.
    expect(approved.documents.map((d) => d.uri)).toEqual([
      "gno://work/a1.md",
      "gno://work/a2.md",
      "gno://work/plain.md",
    ]);
  });

  test("invalid metadata never matches and is reported as incomplete coverage", async () => {
    const result = await lsJson("--filter", NOT_DRAFT);
    expect(result.documents.some((d) => d.uri.includes("broken"))).toBe(false);
    expect(result.meta.warnings).toEqual([
      {
        code: "METADATA_COVERAGE_INCOMPLETE",
        message: expect.stringContaining("1 have invalid metadata"),
      },
    ]);

    const terminal = await cli("ls", "--filter", NOT_DRAFT);
    expect(terminal.code).toBe(0);
    expect(terminal.stdout).not.toContain("METADATA_COVERAGE");
    expect(terminal.stderr).toContain("Warning: METADATA_COVERAGE_INCOMPLETE:");
  });

  test("documents pending re-ingestion never match, even when negated", async () => {
    const db = new Database(join(testDir, "data", "index-default.sqlite"));
    try {
      db.exec(
        "UPDATE documents SET ingest_version = 6 WHERE rel_path = 'a1.md'"
      );
    } finally {
      db.close();
    }
    const result = await lsJson("--filter", NOT_DRAFT);
    expect(result.documents.map((d) => d.uri)).toEqual([
      "gno://work/a2.md",
      "gno://work/plain.md",
    ]);
    expect(result.meta.warnings?.[0]?.message).toContain(
      "1 documents need re-ingestion"
    );
    expect((await cli("update")).code).toBe(0);
  });

  test("real output validates against the ls schema", async () => {
    const schema = await loadSchema("ls");
    expect(assertValid(await lsJson("-n", "3"), schema)).toBe(true);
    expect(assertValid(await lsJson("--filter", NOT_DRAFT), schema)).toBe(true);
  });

  test("without --filter the output carries no warnings", async () => {
    const result = await lsJson("-n", "100");
    expect(result.meta).toEqual({
      total: DRAFTS + 4,
      returned: DRAFTS + 4,
      offset: 0,
    });
  });

  test("an invalid filter is the same VALIDATION error as search", async () => {
    for (const filter of ["{", '{"op":"gte","key":"n","value":"1"}']) {
      const listed = await cli("ls", "--filter", filter, "--json");
      const searched = await cli("search", "x", "--filter", filter, "--json");
      expect(listed.code).toBe(1);
      expect(searched.code).toBe(1);
      expect(listed.stderr).toContain("filter:");
      expect(listed.stderr).toBe(searched.stderr);
    }
  });
});

describe("SDK list({ filter })", () => {
  test("returns the same documents and total as the CLI", async () => {
    const config = createDefaultConfig();
    config.collections = [
      {
        name: "work",
        path: docsDir,
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];
    const client = await createGnoClient({
      config,
      dbPath: join(testDir, "data", "index-sdk.sqlite"),
      downloadPolicy: { offline: true, allowDownload: false },
    });
    try {
      await client.update();
      const filter = { op: "eq", key: "status", value: "draft" } as const;
      const sdk = await client.list({ filter, limit: 10, offset: 20 });
      const viaCli = await lsJson(
        "--filter",
        DRAFT,
        "-n",
        "10",
        "--offset",
        "20"
      );
      expect(sdk.meta.total).toBe(viaCli.meta.total);
      expect(sdk.documents.map((d) => d.docid)).toEqual(
        viaCli.documents.map((d) => d.docid)
      );
      const negated = await client.list({
        filter: { op: "not", predicate: filter },
      });
      expect(negated.meta.warnings?.[0]?.code).toBe(
        "METADATA_COVERAGE_INCOMPLETE"
      );
      await expect(
        client.list({ filter: { op: "gte", key: "n", value: "1" } as never })
      ).rejects.toMatchObject({ code: "VALIDATION" });
    } finally {
      await client.close();
    }
  }, 60_000);
});
