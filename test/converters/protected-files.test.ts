import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { ConvertInput } from "../../src/converters/types";

import { markitdownAdapter } from "../../src/converters/adapters/markitdownTs/adapter";
import { DEFAULT_LIMITS } from "../../src/converters/types";

const FIXTURES_DIR = join(import.meta.dir, "../fixtures/conversion");

let stderrData = "";

const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleError = console.error.bind(console);

async function loadInput(
  relativePath: string,
  mime: string,
  ext: ".pdf" | ".xlsx"
): Promise<ConvertInput> {
  const sourcePath = join(FIXTURES_DIR, relativePath);
  const bytes = await Bun.file(sourcePath).bytes();
  return {
    sourcePath,
    relativePath,
    collection: "fixtures",
    bytes: new Uint8Array(bytes),
    mime,
    ext,
    limits: DEFAULT_LIMITS,
  };
}

describe("markitdownAdapter protected files", () => {
  beforeEach(() => {
    stderrData = "";
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      stderrData += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
    console.error = (...args: unknown[]) => {
      stderrData += `${args.join(" ")}\n`;
    };
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    console.error = originalConsoleError;
  });

  test("returns PERMISSION for password-protected PDF without stderr noise", async () => {
    const input = await loadInput(
      "pdf/password-protected.pdf",
      "application/pdf",
      ".pdf"
    );

    const result = await markitdownAdapter.convert(input);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.code).toBe("PERMISSION");
    expect(result.error.message).toBe("File is password-protected");
    expect(result.error.details).toEqual({ protection: "pdf" });
    expect(stderrData).toBe("");
  });

  test("returns PERMISSION for password-protected XLSX without stderr noise", async () => {
    const input = await loadInput(
      "xlsx/password-protected.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xlsx"
    );

    const result = await markitdownAdapter.convert(input);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.code).toBe("PERMISSION");
    expect(result.error.message).toBe("File is password-protected");
    expect(result.error.details).toEqual({ protection: "xlsx" });
    expect(stderrData).toBe("");
  });
});
