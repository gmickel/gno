/**
 * MCP gno_sync tool tests.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

const syncInputSchema = z.object({
  collection: z.string().optional(),
  gitPull: z.boolean().default(false),
  runUpdateCmd: z.boolean().default(false),
});

describe("gno_sync schema", () => {
  test("sync input allows empty object", () => {
    const result = syncInputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("sync input accepts options", () => {
    const result = syncInputSchema.safeParse({
      collection: "notes",
      gitPull: true,
      runUpdateCmd: false,
    });
    expect(result.success).toBe(true);
  });
});
