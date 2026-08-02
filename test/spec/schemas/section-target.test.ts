import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, test } from "bun:test";

import schema from "../../../spec/output-schemas/section-target.schema.json";
import {
  createSectionTarget,
  type SectionTargetV1,
} from "../../../src/core/sections";

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

describe("section-target schema", () => {
  test("accepts createSectionTarget output", async () => {
    const target = await createSectionTarget({
      content: "# Title\n\n## Section\n\nBody text for the schema fixture.\n",
      uri: "gno://work/fixture.md",
      anchor: "section",
    });
    expect(target).not.toBeNull();
    expect(validate(target)).toBe(true);
  });

  test("rejects missing required fields and overlong identity/quote fields", () => {
    const valid = {
      schemaVersion: "1",
      document: { uri: "gno://work/fixture.md" },
      anchor: "section",
      headingPath: ["Title", "Section"],
      occurrence: 1,
      quote: { exact: "Body", prefix: "\n\n", suffix: "\n" },
      sourceFingerprint: "a".repeat(64),
      hints: { line: 3, startOffset: 10, endOffset: 14 },
    } satisfies SectionTargetV1;

    expect(validate(valid)).toBe(true);

    const { schemaVersion: _schemaVersion, ...missingVersion } = valid;
    expect(validate(missingVersion)).toBe(false);

    expect(
      validate({
        ...valid,
        quote: { ...valid.quote, exact: "x".repeat(97) },
      })
    ).toBe(false);

    expect(
      validate({
        ...valid,
        document: { uri: `gno://${"u".repeat(1024)}` },
      })
    ).toBe(false);

    expect(
      validate({
        ...valid,
        anchor: "a".repeat(513),
      })
    ).toBe(false);

    expect(
      validate({
        ...valid,
        headingPath: ["Title", "x".repeat(513)],
      })
    ).toBe(false);

    expect(
      validate({
        ...valid,
        sourceFingerprint: "not-a-hash",
      })
    ).toBe(false);
  });
});
