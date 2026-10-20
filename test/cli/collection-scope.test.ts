import { expect, test } from "bun:test";

import { parseCliCollectionScope } from "../../src/cli/options";

test("repeatable -c keeps one name singular and turns several into an allowlist", () => {
  expect(parseCliCollectionScope(undefined)).toEqual({
    collection: undefined,
  });
  expect(parseCliCollectionScope(["notes"])).toEqual({ collection: "notes" });
  expect(parseCliCollectionScope(["notes", "work", "notes"])).toEqual({
    collections: ["notes", "work"],
  });
});
