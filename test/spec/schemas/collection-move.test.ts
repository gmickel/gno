import { beforeAll, describe, expect, test } from "bun:test";

import type { RelocationResult } from "../../../src/ingestion/relocate";

import { assertInvalid, assertValid, loadSchema } from "./validator";

const receipt = (result: RelocationResult): unknown =>
  JSON.parse(JSON.stringify(result));

describe("collection-move schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("collection-move");
  });

  test("accepts relocated, dry-run and refused items", () => {
    const json = receipt({
      dryRun: false,
      relocated: 1,
      refused: 2,
      items: [
        {
          source: "gno://notes/a.md",
          destination: "gno://data/a.md",
          status: "relocated",
          documentId: 7,
          docid: "#abcdef12",
          titleChanged: false,
        },
        {
          source: "gno://notes/b.md",
          destination: "gno://data/b.md",
          status: "refused",
          documentId: 8,
          docid: "#abcdef13",
          code: "DESTINATION_EXISTS",
          message: "The destination is already indexed",
        },
        {
          source: "#abcdef",
          status: "refused",
          code: "AMBIGUOUS",
          message: "matches 2 documents",
        },
      ],
      projectionErrors: [],
      durationMs: 3,
    });
    expect(assertValid(json, schema)).toBe(true);
    expect(
      assertValid(
        receipt({
          dryRun: true,
          relocated: 1,
          refused: 0,
          items: [
            {
              source: "gno://notes/a.md",
              destination: "gno://data/a.md",
              status: "would_relocate",
            },
          ],
          projectionErrors: [],
          durationMs: 1,
        }),
        schema
      )
    ).toBe(true);
  });

  test("rejects unknown codes and fields", () => {
    expect(
      assertInvalid(
        {
          dryRun: false,
          relocated: 0,
          refused: 1,
          items: [{ source: "x", status: "refused", code: "OOPS" }],
          projectionErrors: [],
          durationMs: 0,
        },
        schema
      )
    ).toBe(true);
    expect(
      assertInvalid(
        {
          dryRun: false,
          relocated: 0,
          refused: 0,
          items: [],
          projectionErrors: [],
          durationMs: 0,
          extra: true,
        },
        schema
      )
    ).toBe(true);
  });
});
