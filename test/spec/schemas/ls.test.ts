import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

const listing = {
  documents: [
    {
      docid: "#a1b2c3d4",
      uri: "gno://work/doc.md",
      title: "Doc",
      source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
    },
  ],
  meta: { total: 12, returned: 1, offset: 0 },
};

describe("ls schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("ls");
  });

  test("validates a listing", () => {
    expect(assertValid(listing, schema)).toBe(true);
  });

  test("validates a filtered listing with a coverage warning", () => {
    const filtered = {
      documents: [],
      meta: {
        total: 0,
        returned: 0,
        offset: 0,
        warnings: [
          { code: "METADATA_COVERAGE_INCOMPLETE", message: "Typed metadata…" },
        ],
      },
    };
    expect(assertValid(filtered, schema)).toBe(true);
  });

  test("rejects the bare array shape", () => {
    expect(assertInvalid(listing.documents, schema)).toBe(true);
  });

  test("rejects a listing without meta.total", () => {
    expect(
      assertInvalid({ documents: [], meta: { returned: 0, offset: 0 } }, schema)
    ).toBe(true);
  });
});
