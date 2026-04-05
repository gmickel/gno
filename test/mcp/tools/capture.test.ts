/**
 * MCP gno_capture tool tests.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

const captureInputSchema = z.object({
  collection: z.string().min(1),
  content: z.string().optional(),
  title: z.string().optional(),
  path: z.string().optional(),
  folderPath: z.string().optional(),
  collisionPolicy: z
    .enum(["error", "open_existing", "create_with_suffix"])
    .optional(),
  presetId: z
    .enum([
      "blank",
      "project-note",
      "research-note",
      "decision-note",
      "prompt-pattern",
      "source-summary",
    ])
    .optional(),
  overwrite: z.boolean().default(false),
  tags: z.array(z.string()).optional(),
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
      title: "My Title",
      path: "my-title.md",
      folderPath: "projects",
      collisionPolicy: "create_with_suffix",
      presetId: "project-note",
      overwrite: true,
    });
    expect(result.success).toBe(true);
  });

  test("capture input accepts tags array", () => {
    const result = captureInputSchema.safeParse({
      collection: "notes",
      content: "hello",
      tags: ["work", "project"],
    });
    expect(result.success).toBe(true);
  });

  test("capture input accepts empty tags array", () => {
    const result = captureInputSchema.safeParse({
      collection: "notes",
      content: "hello",
      tags: [],
    });
    expect(result.success).toBe(true);
  });
});
