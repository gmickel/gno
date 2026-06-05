import { describe, expect, test } from "bun:test";

import { getNotePreset, resolveNotePreset } from "../../src/core/note-presets";

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

  test("preserves decision-note and source-summary IDs", () => {
    expect(getNotePreset("decision-note")?.id).toBe("decision-note");
    expect(getNotePreset("source-summary")?.id).toBe("source-summary");
  });

  test("builds second-brain presets with flat synthesis/timeline scaffolds", () => {
    const presetIds = [
      "idea-original",
      "person",
      "company-project",
      "meeting",
    ] as const;

    for (const presetId of presetIds) {
      const resolved = resolveNotePreset({
        presetId,
        title: "Subject",
      });

      expect(resolved).not.toBeNull();
      expect(resolved?.frontmatter).toEqual({
        type: presetId,
        category: presetId,
        tags: [],
      });
      expect(resolved?.tags).toEqual([]);
      expect(resolved?.content).toContain(`type: "${presetId}"`);
      expect(resolved?.content).toContain(`category: "${presetId}"`);
      expect(resolved?.content).toContain("tags: []");
      expect(resolved?.body).toContain("## Current Synthesis");
      expect(resolved?.body).toContain("## Open Threads");
      expect(resolved?.body).toContain("## Assessment");
      expect(resolved?.body).toContain("## Timeline");
      expect(resolved?.body).not.toContain("---");
      expect(resolved?.content).not.toContain("source:");
    }
  });

  test("meeting preset keeps transcript and action items below timeline", () => {
    const resolved = resolveNotePreset({
      presetId: "meeting",
      title: "Weekly Sync",
    });

    const timelineIndex = resolved?.body.indexOf("## Timeline") ?? -1;
    const transcriptIndex =
      resolved?.body.indexOf("## Transcript / Notes") ?? -1;
    const actionItemsIndex = resolved?.body.indexOf("## Action Items") ?? -1;

    expect(timelineIndex).toBeGreaterThan(-1);
    expect(transcriptIndex).toBeGreaterThan(timelineIndex);
    expect(actionItemsIndex).toBeGreaterThan(timelineIndex);
  });
});
