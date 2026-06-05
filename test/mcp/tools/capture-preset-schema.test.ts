/**
 * MCP gno_capture preset schema tests.
 */

import { describe, expect, test } from "bun:test";

import { NOTE_PRESETS } from "../../../src/core/note-presets";
import { captureInputSchema } from "../../../src/mcp/tools/index";

describe("gno_capture preset schema", () => {
  test("accepts new second-brain presets through the actual MCP schema", () => {
    const parsed = captureInputSchema.parse({
      collection: "notes",
      title: "Jane Doe",
      presetId: "person",
    });

    expect(parsed.presetId).toBe("person");
  });

  test("keeps MCP preset enum aligned with NOTE_PRESETS", () => {
    const presetIdDef = captureInputSchema.shape.presetId;
    const enumValues = new Set(
      presetIdDef.unwrap().options as readonly string[]
    );

    expect(enumValues).toEqual(
      new Set(NOTE_PRESETS.map((preset) => preset.id))
    );
  });
});
