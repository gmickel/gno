import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

const LEXICAL_COMPLETED = {
  state: "completed",
  filesProcessed: 41,
  filesAdded: 41,
  filesUpdated: 0,
  filesErrored: 0,
  filesSkipped: 0,
  durationMs: 569,
};

const EMBED_COMPLETED = {
  state: "completed",
  embedded: 41,
  errors: 0,
  contentionErrors: 0,
  durationMs: 4,
};

describe("index-receipt schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("index-receipt");
  });

  test("accepts a completed two-stage run", () => {
    expect(
      assertValid(
        {
          success: true,
          stages: { lexical: LEXICAL_COMPLETED, embed: EMBED_COMPLETED },
          resumedFrom: null,
          syncResult: { collections: [], totalDurationMs: 569 },
          embedSkipped: false,
          embedResult: {
            embedded: 41,
            errors: 0,
            contentionErrors: 0,
            duration: 0.004,
          },
        },
        schema
      )
    ).toBe(true);
  });

  test("accepts a failed embed stage with partial receipt and a resume marker", () => {
    expect(
      assertValid(
        {
          success: false,
          error: "Embed stage failed: connection refused",
          stages: {
            lexical: LEXICAL_COMPLETED,
            embed: {
              state: "failed",
              embedded: 0,
              errors: 0,
              contentionErrors: 0,
              durationMs: 0,
              error: "connection refused",
            },
          },
          resumedFrom: {
            stage: "embed",
            state: "interrupted",
            startedAt: "2026-09-03T06:00:02.000Z",
            pid: 4242,
            collection: "notes",
          },
          syncResult: { collections: [] },
          embedSkipped: false,
        },
        schema
      )
    ).toBe(true);
  });

  test("accepts a --no-embed run with a skipped embed stage", () => {
    expect(
      assertValid(
        {
          success: true,
          stages: {
            lexical: LEXICAL_COMPLETED,
            embed: {
              ...EMBED_COMPLETED,
              state: "skipped",
              reason: "--no-embed",
            },
          },
          resumedFrom: null,
          syncResult: { collections: [] },
          embedSkipped: true,
        },
        schema
      )
    ).toBe(true);
  });

  test("rejects unknown stage states and a missing resumedFrom", () => {
    expect(
      assertInvalid(
        {
          success: true,
          stages: {
            lexical: { ...LEXICAL_COMPLETED, state: "running" },
            embed: EMBED_COMPLETED,
          },
          resumedFrom: null,
          embedSkipped: false,
        },
        schema
      )
    ).toBe(true);
    expect(
      assertInvalid(
        {
          success: true,
          stages: { lexical: LEXICAL_COMPLETED, embed: EMBED_COMPLETED },
          embedSkipped: false,
        },
        schema
      )
    ).toBe(true);
  });
});
