import { expect, test } from "bun:test";
import { z } from "zod";

import { loadEvidenceFixtures } from "../../../evals/acceptance/evidence-fixtures";
import {
  evidenceFixturesSchema,
  evidenceReportSchema,
  evidenceRunSchema,
} from "../../../evals/acceptance/evidence-schema";
import { assertInvalid, assertValid } from "./validator";

for (const [name, schema] of [
  ["evidence-fixtures", evidenceFixturesSchema],
  ["evidence-run", evidenceRunSchema],
  ["evidence-report", evidenceReportSchema],
] as const) {
  test(`${name} checked-in schema matches the strict development contract`, async () => {
    const published = await Bun.file(
      `spec/output-schemas/${name}.schema.json`
    ).json();
    expect(published).toEqual(
      z.toJSONSchema(schema, { target: "draft-7", reused: "ref" })
    );
    expect(
      assertInvalid({ schemaVersion: "not-a-real-version" }, published)
    ).toBe(true);
  });
}

test("original corpus validates against the public fixture contract", async () => {
  const { fixtures } = await loadEvidenceFixtures();
  const schema = await Bun.file(
    "spec/output-schemas/evidence-fixtures.schema.json"
  ).json();
  expect(assertValid(fixtures, schema)).toBe(true);
  expect(assertInvalid({ ...fixtures, ignoredExtraField: true }, schema)).toBe(
    true
  );
});
