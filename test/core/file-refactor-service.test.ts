/**
 * Happy-path and fail-closed apply-service tests.
 *
 * @module test/core/file-refactor-service
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  applyFileRefactor,
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_SCHEMA_VERSION,
  fingerprintUtf8Content,
  planFileRefactorImpact,
} from "../../src/core/file-refactors";
import {
  buildRenamePlan,
  cleanupTempDirs,
  depsFor,
  exists,
  makeRoot,
  readNote,
  writeNote,
} from "./file-refactor-service-helpers";

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

describe("applyFileRefactor happy path", () => {
  test("renames with multiple referrers, self-link, descending edits, preserves unrelated bytes", async () => {
    const root = await makeRoot(tempDirs);
    const sourceContent =
      "Title\nSee [[Old Note#A]] and [self](old-note.md) plus unrelated ζ.\n";
    const refA =
      'Intro\nSee [[Old Note|Alias]] and [x](old-note.md "T") end.\n';
    const refB = "Only [[Old Note]] here.\n";
    await writeNote(root, "old-note.md", sourceContent);
    await writeNote(root, "a.md", refA);
    await writeNote(root, "b.md", refB);

    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent,
      referrers: [
        { relPath: "a.md", content: refA },
        { relPath: "b.md", content: refB },
      ],
    });
    expect(plan.canApply).toBe(true);

    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root)
    );

    expect(result.status).toBe("applied");
    expect(await exists(root, "old-note.md")).toBe(false);
    expect(await exists(root, "new-note.md")).toBe(true);
    const moved = await readNote(root, "new-note.md");
    expect(moved).toContain("[[New Note#A]]");
    expect(moved).toContain("[self](new-note.md)");
    expect(moved).toContain("unrelated ζ");
    const a = await readNote(root, "a.md");
    expect(a).toContain("[[New Note|Alias]]");
    expect(a).toContain('[x](new-note.md "T")');
    expect(a).toContain("Intro\n");
    expect(a).toContain(" end.\n");
    expect(await readNote(root, "b.md")).toBe("Only [[New Note]] here.\n");
  });

  test("move into nested folder rewrites referrers", async () => {
    const root = await makeRoot(tempDirs);
    const sourceContent = "# Note\n";
    const ref = "See [[Old Note]].\n";
    await writeNote(root, "old-note.md", sourceContent);
    await writeNote(root, "ref.md", ref);

    const plan = await planFileRefactorImpact({
      operation: "move",
      source: {
        uri: "gno://notes/old-note.md",
        relPath: "old-note.md",
        collection: "notes",
        title: "Old Note",
        content: sourceContent,
        editable: true,
      },
      target: {
        uri: "gno://notes/archive/old-note.md",
        relPath: "archive/old-note.md",
        collection: "notes",
        title: "Old Note",
      },
      documents: [
        {
          id: 1,
          uri: "gno://notes/old-note.md",
          relPath: "old-note.md",
          collection: "notes",
          title: "Old Note",
          content: sourceContent,
        },
        {
          id: 2,
          uri: "gno://notes/ref.md",
          relPath: "ref.md",
          collection: "notes",
          title: "ref",
          content: ref,
        },
      ],
      targetOccupied: false,
    });
    expect(plan.canApply).toBe(true);

    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root)
    );
    expect(result.status).toBe("applied");
    expect(await exists(root, "old-note.md")).toBe(false);
    expect(await exists(root, "archive/old-note.md")).toBe(true);
  });
});

describe("applyFileRefactor fail-closed before mutation", () => {
  test("stale source fingerprint leaves files unchanged", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old-note.md", "# Old\n");
    await writeNote(root, "ref.md", "See [[Old Note]].\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [{ relPath: "ref.md", content: "See [[Old Note]].\n" }],
    });
    await writeNote(root, "old-note.md", "# Changed\n");

    const before = await readNote(root, "ref.md");
    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root)
    );
    expect(result.status).toBe("stale_plan");
    expect(await exists(root, "old-note.md")).toBe(true);
    expect(await exists(root, "new-note.md")).toBe(false);
    expect(await readNote(root, "ref.md")).toBe(before);
  });

  test("stale affected fingerprint leaves files unchanged", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old-note.md", "# Old\n");
    await writeNote(root, "ref.md", "See [[Old Note]].\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [{ relPath: "ref.md", content: "See [[Old Note]].\n" }],
    });
    await writeNote(root, "ref.md", "See [[Old Note]] changed.\n");

    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root)
    );
    expect(result.status).toBe("stale_plan");
    expect(await exists(root, "new-note.md")).toBe(false);
  });

  test("occupied target returns conflict unchanged", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old-note.md", "# Old\n");
    await writeNote(root, "new-note.md", "# Taken\n");
    await writeNote(root, "ref.md", "See [[Old Note]].\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [{ relPath: "ref.md", content: "See [[Old Note]].\n" }],
    });

    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root)
    );
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.reasonCode).toBe("occupied_target");
    }
    expect(await exists(root, "old-note.md")).toBe(true);
  });

  test("canApply false after digest recompute returns unsupported unchanged", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old-note.md", "# Old\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [],
    });
    const { computeFileRefactorPlanDigest } =
      await import("../../src/core/file-refactor-contract");
    const { planDigest: _drop, ...rest } = {
      ...plan,
      canApply: false as const,
    };
    const deniedDigest = await computeFileRefactorPlanDigest(rest);
    const denied = {
      ...rest,
      planDigest: deniedDigest,
      canApply: false as const,
    };

    const deniedResult = await applyFileRefactor(
      denied,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: denied.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root)
    );
    expect(deniedResult.status).toBe("unsupported");
    expect(await exists(root, "new-note.md")).toBe(false);

    const badDigest = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: "0".repeat(64),
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root)
    );
    expect(badDigest.status).toBe("stale_plan");
    expect(await exists(root, "new-note.md")).toBe(false);
  });

  test("bad confirmation token returns unsupported unchanged", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old-note.md", "# Old\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [],
    });
    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: "yes" as typeof FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root)
    );
    expect(result.status).toBe("unsupported");
    expect(await exists(root, "new-note.md")).toBe(false);
  });

  test("lock contention returns conflict with zero mutation", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old-note.md", "# Old\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [],
    });
    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, { acquireLock: async () => null })
    );
    expect(result.status).toBe("conflict");
    expect(await exists(root, "new-note.md")).toBe(false);
  });
});

describe("fingerprint helper", () => {
  test("stable utf8 fingerprint", async () => {
    expect(await fingerprintUtf8Content("a")).toHaveLength(64);
  });
});
