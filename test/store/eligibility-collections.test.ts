import { expect, test } from "bun:test";

import { buildEligibleDocumentQuery } from "../../src/store/sqlite/eligibility";

test("collections compiles to a pre-limit IN allowlist", () => {
  const { sql, params } = buildEligibleDocumentQuery({
    collections: ["alpha", "beta"],
  });
  expect(sql).toContain("d.collection IN (SELECT value FROM json_each(?))");
  expect(params).toContain(JSON.stringify(["alpha", "beta"]));
});

test("unset collections leaves the query unchanged", () => {
  expect(buildEligibleDocumentQuery({ collection: "alpha" })).toEqual(
    buildEligibleDocumentQuery({ collection: "alpha", collections: undefined })
  );
  expect(buildEligibleDocumentQuery({}).sql).not.toContain("json_each");
});
