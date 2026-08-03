import { describe, expect, test } from "bun:test";

import {
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_SCHEMA_VERSION,
} from "../../../src/core/file-refactors";
import {
  moveNoteInputSchema,
  renameNoteInputSchema,
} from "../../../src/mcp/tools/workspace-write";

describe("workspace write MCP schemas", () => {
  test("rename preview schema accepts required fields", () => {
    expect(
      renameNoteInputSchema.safeParse({
        action: "preview",
        ref: "notes/doc.md",
        name: "renamed.md",
      }).success
    ).toBe(true);
  });

  test("rename apply requires exact confirmation gates", () => {
    expect(
      renameNoteInputSchema.safeParse({
        action: "apply",
        ref: "notes/doc.md",
        name: "renamed.md",
      }).success
    ).toBe(false);
    expect(
      renameNoteInputSchema.safeParse({
        action: "apply",
        ref: "notes/doc.md",
        name: "renamed.md",
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: "d".repeat(64),
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        confirm: true,
      }).success
    ).toBe(true);
    expect(
      renameNoteInputSchema.safeParse({
        action: "apply",
        ref: "notes/doc.md",
        name: "renamed.md",
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: "d".repeat(64),
        confirmation: "yes",
        confirm: true,
      }).success
    ).toBe(false);
  });

  test("move preview schema accepts destination folder", () => {
    expect(
      moveNoteInputSchema.safeParse({
        action: "preview",
        ref: "notes/doc.md",
        folderPath: "projects",
      }).success
    ).toBe(true);
  });

  test("move apply requires confirm true plus exact digest", () => {
    expect(
      moveNoteInputSchema.safeParse({
        action: "apply",
        ref: "notes/doc.md",
        folderPath: "projects",
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: "a".repeat(64),
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        confirm: false,
      }).success
    ).toBe(false);
    expect(
      moveNoteInputSchema.safeParse({
        action: "apply",
        ref: "notes/doc.md",
        folderPath: "projects",
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: "a".repeat(64),
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        confirm: true,
      }).success
    ).toBe(true);
  });

  test("legacy direct-apply payloads without action are rejected", () => {
    expect(
      renameNoteInputSchema.safeParse({
        ref: "notes/doc.md",
        name: "renamed.md",
      }).success
    ).toBe(false);
    expect(
      moveNoteInputSchema.safeParse({
        ref: "notes/doc.md",
        folderPath: "archive",
      }).success
    ).toBe(false);
  });
});
