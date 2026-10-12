import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("ls schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("ls");
  });

  const doc = {
    docid: "#a1b2c3d4",
    uri: "gno://work/doc.md",
    title: "Doc",
    source: { relPath: "doc.md", mime: "text/markdown", ext: ".md" },
  };

  test("validates a document list", () => {
    expect(
      assertValid(
        { documents: [doc], meta: { total: 1, returned: 1, offset: 0 } },
        schema
      )
    ).toBe(true);
  });

  test("validates an empty filtered list", () => {
    expect(
      assertValid(
        { documents: [], meta: { total: 0, returned: 0, offset: 0 } },
        schema
      )
    ).toBe(true);
  });

  test("rejects missing meta and unknown keys", () => {
    expect(assertInvalid({ documents: [doc] }, schema)).toBe(true);
    expect(
      assertInvalid(
        {
          documents: [{ ...doc, metadata: {} }],
          meta: { total: 1, returned: 1, offset: 0 },
        },
        schema
      )
    ).toBe(true);
  });
});
