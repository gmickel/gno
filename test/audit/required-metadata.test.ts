import { describe, expect, test } from "bun:test";

import { evaluateRequiredMetadataAudit } from "../../src/core/audit-provenance";

const doc = (
  collection: string,
  relPath: string,
  typedMetadata?: Record<string, unknown> | null
) => ({
  uri: `gno://${collection}/${relPath}`,
  relPath,
  collection,
  typedMetadata: typedMetadata as never,
});

describe("provenance.required-metadata", () => {
  test("does not run unless an audited collection sets access", () => {
    expect(
      evaluateRequiredMetadataAudit([doc("notes", "a.md")], [{ name: "notes" }])
    ).toEqual([]);
  });

  test("flags missing and invalid derived_from in access collections only", () => {
    const [rule] = evaluateRequiredMetadataAudit(
      [
        doc("wiki", "ok.md", { derived_from: ["sp:drives/d/items/i"] }),
        doc("wiki", "missing.md"),
        doc("wiki", "bad.md", { derived_from: ["no-system"] }),
        doc("notes", "free.md"),
      ],
      [{ name: "wiki", access: { public: true } }, { name: "notes" }]
    );
    expect(rule?.ruleId).toBe("provenance.required-metadata");
    expect(rule?.status).toBe("fail");
    expect(rule?.examinedCount).toBe(3);
    expect(rule?.findings?.map((f) => [f.subject, f.message])).toEqual([
      [
        "gno://wiki/bad.md",
        "required provenance metadata is invalid: derived_from",
      ],
      [
        "gno://wiki/missing.md",
        "required provenance metadata is missing: derived_from",
      ],
    ]);
  });

  test("passes when every access-collection document is servable", () => {
    const [rule] = evaluateRequiredMetadataAudit(
      [doc("wiki", "ok.md", { derived_from: ["web:https://example.com"] })],
      [{ name: "wiki", access: { owner: "u:1" } }]
    );
    expect(rule?.status).toBe("pass");
    expect(rule?.findings).toEqual([]);
  });
});
