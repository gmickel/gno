import { describe, expect, test } from "bun:test";
import { z } from "zod";

const createFolderInputSchema = z.object({
  collection: z.string().min(1),
  name: z.string().min(1),
  parentPath: z.string().optional(),
});

const renameNoteInputSchema = z.object({
  ref: z.string().min(1),
  name: z.string().min(1),
});

const moveNoteInputSchema = z.object({
  ref: z.string().min(1),
  folderPath: z.string().min(1),
  name: z.string().optional(),
});

const duplicateNoteInputSchema = z.object({
  ref: z.string().min(1),
  folderPath: z.string().optional(),
  name: z.string().optional(),
});

describe("workspace write MCP schemas", () => {
  test("create folder schema accepts required fields", () => {
    expect(
      createFolderInputSchema.safeParse({
        collection: "notes",
        name: "research",
      }).success
    ).toBe(true);
  });

  test("rename note schema accepts required fields", () => {
    expect(
      renameNoteInputSchema.safeParse({
        ref: "notes/doc.md",
        name: "renamed.md",
      }).success
    ).toBe(true);
  });

  test("move note schema accepts destination folder", () => {
    expect(
      moveNoteInputSchema.safeParse({
        ref: "notes/doc.md",
        folderPath: "projects",
      }).success
    ).toBe(true);
  });

  test("duplicate note schema accepts optional target overrides", () => {
    expect(
      duplicateNoteInputSchema.safeParse({
        ref: "notes/doc.md",
        folderPath: "archive",
        name: "copy.md",
      }).success
    ).toBe(true);
  });
});
