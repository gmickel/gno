import { beforeAll, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

let schema: object;
let fixture: Record<string, unknown>;

beforeAll(async () => {
  schema = await loadSchema("status");
  fixture = await Bun.file("test/fixtures/outputs/status-healthy.json").json();
});

const configured = { maxTokens: 256, overlapPercent: 0 };

test.each(["empty", "legacy-default", "current", "pending", "mixed"])(
  "status schema accepts the %s chunk-layout state",
  (state) => {
    expect(
      assertValid(
        {
          ...fixture,
          chunking: {
            configured,
            applied: state === "mixed" || state === "empty" ? null : configured,
            state,
            pendingDocuments: 0,
            pendingMirrors: 0,
          },
        },
        schema
      )
    ).toBe(true);
  }
);

test("status schema rejects invalid policy units, states and counts", () => {
  const chunking = {
    configured,
    applied: configured,
    state: "current",
    pendingDocuments: 0,
    pendingMirrors: 0,
  };
  for (const invalid of [
    { ...chunking, configured: { maxTokens: 256, overlapPercent: 15 } },
    { ...chunking, applied: { maxTokens: 1, overlapPercent: 0 } },
    { ...chunking, state: "success" },
    { ...chunking, pendingDocuments: -1 },
    { ...chunking, pendingMirrors: 1.5 },
    { ...chunking, generation: 12 },
  ]) {
    expect(assertInvalid({ ...fixture, chunking: invalid }, schema)).toBe(true);
  }
});
