/**
 * Repeatable `-c` on search, vsearch and query (fn-222).
 * vsearch/query error cases are refused before any model is resolved.
 */

import Ajv from "ajv";
// oxlint-disable-next-line import/no-namespace -- ajv-formats requires namespace for .default
import * as addFormatsModule from "ajv-formats";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for mkdir/mkdtemp: Bun has no directory-creation API.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os/node:path for tmpdir/join: no Bun equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import searchResultsSchema from "../../spec/output-schemas/search-results.schema.json";
import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";

const addFormats = addFormatsModule.default;
const ajv = new Ajv();
addFormats(ajv);
const validateSearchResults = ajv.compile(searchResultsSchema);

let stdoutData = "";
let stderrData = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

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

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "gno-cli-collections-"));
  process.env.GNO_CONFIG_DIR = join(testDir, "config");
  process.env.GNO_DATA_DIR = join(testDir, "data");
  process.env.GNO_CACHE_DIR = join(testDir, "cache");
  const notes: Record<string, string> = {
    alpha: "# Alpha\n\nThe deploy runbook for alpha.",
    beta: "# Beta\n\nThe deploy checklist for beta.",
    gamma: "# Gamma\n\nThe deploy notes for gamma.",
  };
  for (const [name, text] of Object.entries(notes)) {
    const dir = join(testDir, name);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, `${name}.md`), text);
  }
  expect(
    (await cli("init", join(testDir, "alpha"), "--name", "alpha")).code
  ).toBe(0);
  for (const name of ["beta", "gamma"]) {
    expect(
      (await cli("collection", "add", join(testDir, name), "--name", name)).code
    ).toBe(0);
  }
  expect((await cli("update")).code).toBe(0);
});

afterAll(async () => {
  await safeRm(testDir);
  Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
  Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
  Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
});

const uris = (stdout: string) =>
  (JSON.parse(stdout) as { results: { uri: string }[] }).results
    .map(({ uri }) => uri)
    .toSorted();

describe("repeatable -c", () => {
  test("search -c twice serves only those collections and echoes them", async () => {
    const { code, stdout } = await cli(
      "search",
      "deploy",
      "-c",
      "gamma",
      "-c",
      "Alpha",
      "--json"
    );
    expect(code).toBe(0);
    expect(uris(stdout)).toEqual([
      "gno://alpha/alpha.md",
      "gno://gamma/gamma.md",
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.meta.collections).toEqual(["alpha", "gamma"]);
    expect(parsed.meta.collection).toBeUndefined();
    expect(validateSearchResults(parsed)).toBe(true);
  });

  test("a single -c keeps the single-collection output", async () => {
    const { code, stdout } = await cli(
      "search",
      "deploy",
      "-c",
      "beta",
      "--json"
    );
    expect(code).toBe(0);
    expect(uris(stdout)).toEqual(["gno://beta/beta.md"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.meta.collection).toBe("beta");
    expect(stdout).not.toContain('"collections"');
  });

  for (const command of ["search", "vsearch", "query"]) {
    test(`${command} names every unknown collection with the unknown-collection exit`, async () => {
      const { code, stderr } = await cli(
        command,
        "deploy",
        "-c",
        "alpha",
        "-c",
        "nope",
        "-c",
        "gone"
      );
      expect(code).toBe(2);
      expect(stderr).toContain("Collections not found: gone, nope");
    });

    test(`${command} refuses more than 256 collections as validation`, async () => {
      const flags = Array.from({ length: 257 }, (_, i) => [
        "-c",
        `c${i}`,
      ]).flat();
      const { code, stderr } = await cli(command, "deploy", ...flags);
      expect(code).toBe(1);
      expect(stderr).toContain("collections must list at most 256 names");
    });
  }

  test("query --diagnose refuses several -c", async () => {
    const { code, stderr } = await cli(
      "query",
      "diagnose",
      "deploy",
      "--target",
      "gno://alpha/alpha.md",
      "-c",
      "alpha",
      "-c",
      "beta"
    );
    expect(code).toBe(1);
    expect(stderr).toContain("query --diagnose accepts a single -c collection");
  });
});
