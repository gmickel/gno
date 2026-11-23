import { beforeAll, describe, expect, test } from "bun:test";

import { formatVecGc } from "../../../src/cli/commands/vec";
import { assertInvalid, assertValid, loadSchema } from "./validator";

const REPORT = {
  success: true as const,
  dryRun: false,
  partitions: [
    {
      id: "a".repeat(64),
      model: "hf:org/model/model.gguf",
      dimensions: 384,
      state: "active" as const,
      legacy: false,
      examined: 10,
      variants: 3,
      bytes: 4608,
    },
    {
      id: "b".repeat(64),
      model: "hf:org/model/model.gguf",
      dimensions: 384,
      state: "shadow" as const,
      legacy: true,
      examined: 0,
      variants: 0,
      bytes: 0,
      skipped: "sqlite-vec is unavailable",
    },
  ],
  variants: 3,
  bytes: 4608,
  legacyContentVectors: 0,
  databaseBytes: 1_048_576,
  freeBytes: 8192,
};

describe("vec-gc schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("vec-gc");
  });

  test("accepts the printed report, including a skipped partition", () => {
    const json = JSON.parse(formatVecGc(REPORT, { json: true }));
    expect(json).not.toHaveProperty("success");
    expect(assertValid(json, schema)).toBe(true);
  });

  test("rejects unknown fields and a missing size", () => {
    const { success: _s, ...report } = REPORT;
    expect(assertInvalid({ ...report, extra: 1 }, schema)).toBe(true);
    const { freeBytes: _f, ...missing } = report;
    expect(assertInvalid(missing, schema)).toBe(true);
  });
});
