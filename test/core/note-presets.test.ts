import { describe, expect, test } from "bun:test";

import { resolveNotePreset } from "../../src/core/note-presets";

describe("note presets", () => {
  test("builds project preset scaffolds with frontmatter", () => {
    const resolved = resolveNotePreset({
      presetId: "project-note",
      title: "Launch Work",
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.content).toContain('category: "project"');
    expect(resolved?.content).toContain("# Launch Work");
    expect(resolved?.content).toContain("## Goal");
    expect(resolved?.tags).toContain("project");
  });

  test("serializes empty array frontmatter safely", () => {
    const resolved = resolveNotePreset({
      presetId: "source-summary",
      title: "Paper Review",
    });

    expect(resolved?.content).toContain("sources: []");
  });
});
