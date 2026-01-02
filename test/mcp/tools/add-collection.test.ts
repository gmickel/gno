/**
 * MCP gno_add_collection tool tests.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

const addCollectionInputSchema = z.object({
  path: z.string().min(1),
  name: z.string().optional(),
  pattern: z.string().optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  gitPull: z.boolean().default(false),
});

describe("gno_add_collection schema", () => {
  test("add collection requires path", () => {
    const result = addCollectionInputSchema.safeParse({
      path: "/tmp/notes",
    });
    expect(result.success).toBe(true);
  });

  test("add collection accepts optional fields", () => {
    const result = addCollectionInputSchema.safeParse({
      path: "/tmp/notes",
      name: "notes",
      pattern: "**/*.md",
      include: ["**/*.md"],
      exclude: ["node_modules"],
      gitPull: true,
    });
    expect(result.success).toBe(true);
  });
});
