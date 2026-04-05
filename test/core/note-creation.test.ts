import { describe, expect, test } from "bun:test";

import { resolveNoteCreatePlan } from "../../src/core/note-creation";

describe("note creation planning", () => {
  test("resolves folder-aware create paths", () => {
    const plan = resolveNoteCreatePlan(
      {
        collection: "notes",
        title: "Project Plan",
        folderPath: "projects/gno",
      },
      []
    );

    expect(plan.relPath).toBe("projects/gno/project-plan.md");
    expect(plan.openedExisting).toBe(false);
    expect(plan.createdWithSuffix).toBe(false);
  });

  test("returns open-existing plan when collision policy requests it", () => {
    const plan = resolveNoteCreatePlan(
      {
        collection: "notes",
        title: "Project Plan",
        collisionPolicy: "open_existing",
      },
      ["project-plan.md"]
    );

    expect(plan.openedExisting).toBe(true);
    expect(plan.relPath).toBe("project-plan.md");
  });

  test("creates suffixed names when requested", () => {
    const plan = resolveNoteCreatePlan(
      {
        collection: "notes",
        title: "Project Plan",
        collisionPolicy: "create_with_suffix",
      },
      ["project-plan.md", "project-plan-2.md"]
    );

    expect(plan.relPath).toBe("project-plan-3.md");
    expect(plan.createdWithSuffix).toBe(true);
  });
});
