/**
 * Contract: collection sourceAvailability config parsing.
 */

import { describe, expect, test } from "bun:test";

import { CollectionSchema } from "../../../src/config/types";
import {
  DEFAULT_SOURCE_AVAILABILITY,
  resolveSourceAvailability,
} from "../../../src/ingestion/source-availability";

const base = {
  name: "notes",
  path: "/tmp/notes",
};

describe("sourceAvailability config contract", () => {
  test("defaults to any when omitted (behaviorally unchanged)", () => {
    const parsed = CollectionSchema.parse(base);
    // Omitted in config → undefined on object; effective mode resolves to any.
    expect(parsed.sourceAvailability).toBeUndefined();
    expect(resolveSourceAvailability(parsed)).toBe("any");
    expect(resolveSourceAvailability(parsed)).toBe(DEFAULT_SOURCE_AVAILABILITY);
  });

  test.each([
    { input: "any", expected: "any" as const },
    { input: "local", expected: "local" as const },
  ])("accepts exact mode $input", ({ input, expected }) => {
    const parsed = CollectionSchema.parse({
      ...base,
      sourceAvailability: input,
    });
    expect(parsed.sourceAvailability).toBe(expected);
  });

  test.each([
    { input: "cloud" },
    { input: "ALL" },
    { input: "" },
    { input: true },
    { input: 1 },
    { input: null },
    { input: ["any"] },
  ])("rejects malformed sourceAvailability %#", ({ input }) => {
    const result = CollectionSchema.safeParse({
      ...base,
      sourceAvailability: input,
    });
    expect(result.success).toBe(false);
  });

  test("SyncOptions override wins over collection config", () => {
    const collection = CollectionSchema.parse({
      ...base,
      sourceAvailability: "any",
    });
    expect(
      resolveSourceAvailability(collection, { sourceAvailability: "local" })
    ).toBe("local");
  });
});
