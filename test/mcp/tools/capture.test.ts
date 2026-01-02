/**
 * MCP gno_capture tool tests.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

const captureInputSchema = z.object({
  collection: z.string().min(1),
  content: z.string(),
  title: z.string().optional(),
  path: z.string().optional(),
  overwrite: z.boolean().default(false),
});

describe("gno_capture schema", () => {
  test("capture input accepts required fields", () => {
    const result = captureInputSchema.safeParse({
      collection: "notes",
      content: "hello",
    });
    expect(result.success).toBe(true);
  });

  test("capture input accepts optional fields", () => {
    const result = captureInputSchema.safeParse({
      collection: "notes",
      content: "hello",
      title: "My Title",
      path: "my-title.md",
      overwrite: true,
    });
    expect(result.success).toBe(true);
  });
});
