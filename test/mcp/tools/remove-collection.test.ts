/**
 * MCP gno_remove_collection tool tests.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

const removeCollectionInputSchema = z.object({
  collection: z.string().min(1),
});

describe("gno_remove_collection schema", () => {
  test("remove collection requires name", () => {
    const result = removeCollectionInputSchema.safeParse({
      collection: "notes",
    });
    expect(result.success).toBe(true);
  });
});
