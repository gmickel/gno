/**
 * MCP gno_list_tags tool tests.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

const listTagsInputSchema = z.object({
  collection: z.string().optional(),
  prefix: z.string().optional(),
});

const listTagsOutputSchema = z.object({
  tags: z.array(
    z.object({
      tag: z.string(),
      count: z.number(),
    })
  ),
  meta: z.object({
    collection: z.string().optional(),
    prefix: z.string().optional(),
    totalTags: z.number(),
  }),
});

describe("gno_list_tags schema", () => {
  test("list_tags input accepts empty object", () => {
    const result = listTagsInputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("list_tags input accepts collection filter", () => {
    const result = listTagsInputSchema.safeParse({
      collection: "notes",
    });
    expect(result.success).toBe(true);
  });

  test("list_tags input accepts prefix filter", () => {
    const result = listTagsInputSchema.safeParse({
      prefix: "work/",
    });
    expect(result.success).toBe(true);
  });

  test("list_tags input accepts both filters", () => {
    const result = listTagsInputSchema.safeParse({
      collection: "notes",
      prefix: "project/",
    });
    expect(result.success).toBe(true);
  });

  test("list_tags output schema structure", () => {
    const validOutput = {
      tags: [
        { tag: "work", count: 5 },
        { tag: "personal", count: 3 },
      ],
      meta: {
        collection: "notes",
        prefix: undefined,
        totalTags: 2,
      },
    };
    const result = listTagsOutputSchema.safeParse(validOutput);
    expect(result.success).toBe(true);
  });

  test("list_tags output accepts empty tags array", () => {
    const validOutput = {
      tags: [],
      meta: {
        totalTags: 0,
      },
    };
    const result = listTagsOutputSchema.safeParse(validOutput);
    expect(result.success).toBe(true);
  });
});
