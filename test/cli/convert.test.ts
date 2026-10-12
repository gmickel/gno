import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for mkdtemp: no Bun equivalent.
import { mkdtemp } from "node:fs/promises";
// node:os/node:path for tmpdir/join: no Bun equivalent.
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const FIXTURES = join(import.meta.dir, "../fixtures/conversion");

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
    const code = await runCli(["bun", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

describe("gno convert", () => {
  let root: string;
  let schema: object;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-convert-"));
    process.env.GNO_CONFIG_DIR = join(root, "config");
    process.env.GNO_DATA_DIR = join(root, "data");
    process.env.GNO_CACHE_DIR = join(root, "cache");
    schema = await loadSchema("convert");
  });

  afterAll(async () => {
    Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
    Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
    Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
    await safeRm(root);
  });

  test("converts a pdf to markdown with --json", async () => {
    const { code, stdout } = await cli(
      "convert",
      join(FIXTURES, "pdf/sample.pdf"),
      "--json"
    );
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(assertValid(out, schema)).toBe(true);
    expect(out.source.mime).toBe("application/pdf");
    expect(out.markdown.length).toBeGreaterThan(0);
    expect(Array.isArray(out.warnings)).toBe(true);
    expect(out.mirrorHash).toBe(
      new Bun.CryptoHasher("sha256").update(out.markdown).digest("hex")
    );
  });

  test("converts a docx to markdown with --json", async () => {
    const { code, stdout } = await cli(
      "convert",
      join(FIXTURES, "docx/sample.docx"),
      "--json"
    );
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(assertValid(out, schema)).toBe(true);
    expect(out.source.ext).toBe(".docx");
    expect(out.markdown.length).toBeGreaterThan(0);
  });

  test("terminal output is the markdown only", async () => {
    const file = join(FIXTURES, "docx/sample.docx");
    const json = JSON.parse((await cli("convert", file, "--json")).stdout);
    const { code, stdout } = await cli("convert", file);
    expect(code).toBe(0);
    expect(stdout).toBe(`${json.markdown}\n`);
  });

  test("over-limit file fails with a typed TOO_LARGE error", async () => {
    const { code, stdout, stderr } = await cli(
      "convert",
      join(FIXTURES, "pdf/sample.pdf"),
      "--max-bytes",
      "10",
      "--json"
    );
    expect(code).toBe(1);
    expect(stdout).toBe("");
    const err = JSON.parse(stderr.trim());
    expect(err.error.code).toBe("VALIDATION");
    expect(err.error.details.reason).toBe("TOO_LARGE");
    expect(err.error.details.limit).toBe(10);
    expect(err.error.details.size).toBeGreaterThan(10);
  });

  test("missing file fails with NOT_FOUND", async () => {
    const { code, stderr } = await cli(
      "convert",
      join(root, "nope.pdf"),
      "--json"
    );
    expect(code).toBe(1);
    expect(JSON.parse(stderr.trim()).error.details.reason).toBe("NOT_FOUND");
  });

  test("corrupt pdf fails as a runtime error with the converter code", async () => {
    const { code, stderr } = await cli(
      "convert",
      join(FIXTURES, "pdf/corrupt.pdf"),
      "--json"
    );
    expect(code).toBe(2);
    const err = JSON.parse(stderr.trim());
    expect(err.error.code).toBe("RUNTIME");
    expect(typeof err.error.details.reason).toBe("string");
  });
});
