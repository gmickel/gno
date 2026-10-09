import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

const result = {
  schemaVersion: "convert@1.0",
  source: {
    path: "/home/user/docs/report.pdf",
    mime: "application/pdf",
    ext: ".pdf",
    sizeBytes: 1234,
  },
  converter: { id: "adapter/markitdown-ts", version: "0.0.10" },
  title: "Report",
  languageHint: null,
  markdown: "# Report\n\nBody text.\n",
  mirrorHash: "a".repeat(64),
  warnings: [{ code: "LOSSY", message: "Images dropped" }],
} as const;

describe("convert schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("convert");
  });

  test("validates a result with warnings", () => {
    expect(assertValid(result, schema)).toBe(true);
  });

  test("validates a result with no title and no warnings", () => {
    expect(assertValid({ ...result, title: null, warnings: [] }, schema)).toBe(
      true
    );
  });

  test("rejects a bad mirrorHash", () => {
    expect(assertInvalid({ ...result, mirrorHash: "xyz" }, schema)).toBe(true);
  });

  test("rejects an unknown warning code", () => {
    expect(
      assertInvalid(
        { ...result, warnings: [{ code: "OOPS", message: "x" }] },
        schema
      )
    ).toBe(true);
  });

  test("rejects extra top-level keys", () => {
    expect(assertInvalid({ ...result, extra: 1 }, schema)).toBe(true);
  });
});
