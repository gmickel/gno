import { expect, test } from "bun:test";

import { parseCliMetadataFilter } from "../../src/cli/options";

test("CLI metadata JSON preserves exact types and canonicalizes sets", () => {
  expect(parseCliMetadataFilter(undefined)).toBeUndefined();
  expect(
    parseCliMetadataFilter('{"op":"eq","key":"approved","value":false}')
  ).toEqual({ op: "eq", key: "approved", value: false });
  expect(
    parseCliMetadataFilter('{"op":"in","key":"team","values":["b","a","b"]}')
  ).toEqual({ op: "in", key: "team", values: ["a", "b"] });
});

test("CLI rejects malformed and incompatible predicates instead of dropping them", () => {
  for (const value of [
    "",
    "null",
    "{",
    '{"op":"gte","key":"confidence","value":"0.8"}',
    '{"op":"and","predicates":[]}',
    '{"op":"eq","key":"constructor","value":true}',
  ]) {
    expect(() => parseCliMetadataFilter(value)).toThrow("filter:");
  }
});
