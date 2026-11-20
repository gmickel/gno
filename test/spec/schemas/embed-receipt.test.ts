import { beforeAll, describe, expect, test } from "bun:test";

import { type EmbedResult, formatEmbed } from "../../../src/cli/commands/embed";
import { assertInvalid, assertValid, loadSchema } from "./validator";

const BASE = {
  success: true as const,
  errors: 0,
  contentionErrors: 0,
  duration: 1.25,
  model: "hf:org/model/model.gguf",
  searchAvailable: true,
  errorSamples: [],
};

/** The JSON the CLI prints for a result, parsed back. */
function receipt(result: EmbedResult, dryRun = false): unknown {
  return JSON.parse(formatEmbed(result, { json: true, dryRun }));
}

describe("embed-receipt schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("embed-receipt");
  });

  test("accepts a run stopped at its limit", () => {
    const json = receipt({
      ...BASE,
      embedded: 8,
      remaining: 12,
      stopped: "limit",
    });
    expect(json).toMatchObject({ stopped: "limit", remaining: 12 });
    expect(assertValid(json, schema)).toBe(true);
  });

  test("accepts a completed run", () => {
    const json = receipt({ ...BASE, embedded: 20, remaining: 0 });
    expect(json).not.toHaveProperty("stopped");
    expect(assertValid(json, schema)).toBe(true);
  });

  test("accepts a dry run, which carries no remaining count", () => {
    const json = receipt({ ...BASE, embedded: 20, duration: 0 }, true);
    expect(json).not.toHaveProperty("remaining");
    expect(assertValid(json, schema)).toBe(true);
  });

  test("accepts failures, a sync error and a runtime change", () => {
    const json = receipt({
      ...BASE,
      embedded: 3,
      errors: 2,
      contentionErrors: 1,
      errorSamples: ["HTTP 500"],
      suggestion: "Rerun `gno embed`.",
      syncError: "vec0 unavailable",
      searchAvailable: false,
      remaining: 3,
      incomplete: true,
    });
    expect(assertValid(json, schema)).toBe(true);
  });

  test("rejects unknown stop reasons, a stop without remaining and extra fields", () => {
    const completed = receipt({
      ...BASE,
      embedded: 20,
      remaining: 0,
    }) as Record<string, unknown>;
    expect(assertInvalid({ ...completed, stopped: "time" }, schema)).toBe(true);
    const { remaining: _remaining, ...noRemaining } = completed;
    expect(assertInvalid({ ...noRemaining, stopped: "limit" }, schema)).toBe(
      true
    );
    expect(assertInvalid({ ...completed, attempted: 4 }, schema)).toBe(true);
    expect(assertInvalid({ ...completed, remaining: -1 }, schema)).toBe(true);
  });
});
