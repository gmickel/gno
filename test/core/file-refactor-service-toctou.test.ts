/**
 * TOCTOU parent-symlink, verification, and owned-dir cleanup fixtures.
 *
 * @module test/core/file-refactor-service-toctou
 */

import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises — fixture symlink/rename/unlink only; no Bun equivalents
import { lstat, mkdir, rename, symlink, unlink } from "node:fs/promises";
// node:os platform — skip symlink fixtures on win32
import { platform } from "node:os";
// node:path join — no Bun path utils
import { join } from "node:path";

import { cleanupReceiptArtifacts } from "../../src/core/file-refactor-apply-fs";
import {
  applyFileRefactor,
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_SCHEMA_VERSION,
  planFileRefactorImpact,
  type FileRefactorPreviewPlan,
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

async function dirExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function swapParentDirToOutside(
  root: string,
  parentRel: string,
  outside: string
): Promise<void> {
  const parentAbs = join(root, parentRel);
  await rename(parentAbs, `${parentAbs}.real`);
  await symlink(outside, parentAbs);
}

async function swapFileToOutsideSymlink(
  liveAbs: string,
  outsideSentinel: string,
  exactBytes: string
): Promise<void> {
  await Bun.write(outsideSentinel, exactBytes);
  await unlink(liveAbs);
  await symlink(outsideSentinel, liveAbs);
}

async function movePlan(
  sourceRel: string,
  targetRel: string,
  sourceContent: string
): Promise<FileRefactorPreviewPlan> {
  return planFileRefactorImpact({
    operation: "move",
    source: {
      uri: `gno://notes/${sourceRel}`,
      relPath: sourceRel,
      collection: "notes",
      title: "Old Note",
      content: sourceContent,
      editable: true,
    },
    target: {
      uri: `gno://notes/${targetRel}`,
      relPath: targetRel,
      collection: "notes",
      title: "Old Note",
    },
    documents: [
      {
        id: 1,
        uri: `gno://notes/${sourceRel}`,
        relPath: sourceRel,
        collection: "notes",
        title: "Old Note",
        content: sourceContent,
      },
    ],
    targetOccupied: false,
  });
}

async function applyWith(
  root: string,
  plan: FileRefactorPreviewPlan,
  overrides: Parameters<typeof depsFor>[1] = {}
) {
  return applyFileRefactor(
    plan,
    {
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      planDigest: plan.planDigest,
      confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
    },
    depsFor(root, overrides)
  );
}

describe("refactor apply TOCTOU parent containment", () => {
  test("stage aborts when source parent is swapped to outside symlink", async () => {
    if (platform() === "win32") return;
    const root = await makeRoot(tempDirs);
    const outside = await makeRoot(tempDirs);
    const sentinel = join(outside, "sentinel.md");
    await Bun.write(sentinel, "OUTSIDE_UNCHANGED\n");
    await writeNote(root, "docs/old-note.md", "# Old\n");
    const plan = await buildRenamePlan({
      sourceRel: "docs/old-note.md",
      targetRel: "docs/new-note.md",
      sourceContent: "# Old\n",
      referrers: [],
    });
    const result = await applyWith(root, plan, {
      onBoundary: async (b) => {
        if (b.kind === "stage" && b.role === "source") {
          await swapParentDirToOutside(root, "docs", outside);
        }
      },
    });
    expect(result.status).not.toBe("applied");
    expect(result.filesystem.state).not.toBe("committed");
    expect(await Bun.file(sentinel).text()).toBe("OUTSIDE_UNCHANGED\n");
  });

  test("commit aborts when affected parent is swapped before replace", async () => {
    if (platform() === "win32") return;
    const root = await makeRoot(tempDirs);
    const outside = await makeRoot(tempDirs);
    const sentinel = join(outside, "sentinel.md");
    await Bun.write(sentinel, "OUTSIDE_UNCHANGED\n");
    await writeNote(root, "old-note.md", "# Old\n");
    await writeNote(root, "refs/ref.md", "See [[Old Note]].\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [{ relPath: "refs/ref.md", content: "See [[Old Note]].\n" }],
    });
    const result = await applyWith(root, plan, {
      onBoundary: async (b) => {
        if (b.kind === "commit" && b.role === "affected") {
          await swapParentDirToOutside(root, "refs", outside);
        }
      },
    });
    expect(result.status).not.toBe("applied");
    expect(result.filesystem.state).not.toBe("committed");
    expect(await Bun.file(sentinel).text()).toBe("OUTSIDE_UNCHANGED\n");
    expect(await exists(root, "old-note.md")).toBe(true);
  });

  test("source unlink aborts when parent swapped after target create", async () => {
    if (platform() === "win32") return;
    const root = await makeRoot(tempDirs);
    const outside = await makeRoot(tempDirs);
    const sentinel = join(outside, "sentinel.md");
    await Bun.write(sentinel, "OUTSIDE_UNCHANGED\n");
    const sourceContent = "# Note\n";
    await writeNote(root, "docs/old-note.md", sourceContent);
    const plan = await movePlan(
      "docs/old-note.md",
      "archive/old-note.md",
      sourceContent
    );
    const result = await applyWith(root, plan, {
      onBoundary: async (b) => {
        if (b.kind === "after_commit_target" && b.role === "source") {
          await swapParentDirToOutside(root, "docs", outside);
        }
      },
    });
    expect(result.status).not.toBe("applied");
    expect(result.filesystem.state).not.toBe("committed");
    expect(await Bun.file(sentinel).text()).toBe("OUTSIDE_UNCHANGED\n");
    expect(await Bun.file(join(outside, "old-note.md")).exists()).toBe(false);
  });
});

describe("verification rejects same-fingerprint outside symlink identity", () => {
  test("after_commit_target moved target swap to matching outside symlink never applied", async () => {
    if (platform() === "win32") return;
    const root = await makeRoot(tempDirs);
    const outside = await makeRoot(tempDirs);
    const sentinel = join(outside, "sentinel.md");
    const sourceContent = "# Note\n";
    await writeNote(root, "old-note.md", sourceContent);
    const plan = await movePlan(
      "old-note.md",
      "archive/old-note.md",
      sourceContent
    );
    const result = await applyWith(root, plan, {
      onBoundary: async (b) => {
        if (b.kind === "after_commit_target" && b.role === "source") {
          const targetAbs = join(root, "archive", "old-note.md");
          await swapFileToOutsideSymlink(
            targetAbs,
            sentinel,
            await Bun.file(targetAbs).text()
          );
        }
      },
    });
    expect(result.status).not.toBe("applied");
    expect(result.filesystem.state).not.toBe("committed");
    expect(await Bun.file(sentinel).text()).toBe(sourceContent);
  });

  test("after_commit_target affected swap to matching outside symlink never applied", async () => {
    if (platform() === "win32") return;
    const root = await makeRoot(tempDirs);
    const outside = await makeRoot(tempDirs);
    const sentinel = join(outside, "sentinel.md");
    await writeNote(root, "old-note.md", "# Old\n");
    await writeNote(root, "refs/ref.md", "See [[Old Note]].\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [{ relPath: "refs/ref.md", content: "See [[Old Note]].\n" }],
    });
    const result = await applyWith(root, plan, {
      onBoundary: async (b) => {
        if (b.kind === "after_commit_target" && b.role === "affected") {
          const abs = join(root, "refs", "ref.md");
          await swapFileToOutsideSymlink(
            abs,
            sentinel,
            await Bun.file(abs).text()
          );
        }
      },
    });
    expect(result.status).not.toBe("applied");
    expect(result.filesystem.state).not.toBe("committed");
    expect(await Bun.file(sentinel).text()).toContain("[[");
  });

  test("rollback verification same-fingerprint outside symlink is not rolled_back", async () => {
    if (platform() === "win32") return;
    const root = await makeRoot(tempDirs);
    const outside = await makeRoot(tempDirs);
    const sentinel = join(outside, "sentinel.md");
    const sourceContent = "# Note\n";
    await writeNote(root, "docs/old-note.md", sourceContent);
    const plan = await movePlan(
      "docs/old-note.md",
      "archive/old-note.md",
      sourceContent
    );
    const result = await applyWith(root, plan, {
      onBoundary: async (b) => {
        if (b.kind === "after_commit_target" && b.role === "source") {
          throw new Error("injected after target create");
        }
        if (b.kind === "rollback" && b.role === "source") {
          await swapFileToOutsideSymlink(
            join(root, "docs", "old-note.md"),
            sentinel,
            sourceContent
          );
        }
      },
    });
    expect(result.status).toBe("failed_rolled_back");
    expect(result.filesystem.state).toBe("recovery_required");
    expect(await Bun.file(sentinel).text()).toBe(sourceContent);
  });
});

describe("receipt cleanup parent symlink safety", () => {
  test("cleanup refuses unlink when artifact parent is swapped outside", async () => {
    if (platform() === "win32") return;
    const root = await makeRoot(tempDirs);
    const outside = await makeRoot(tempDirs);
    const artifactName = "note.md.gno-rf-stage.tok";
    const sentinel = join(outside, artifactName);
    await Bun.write(sentinel, "OUTSIDE_UNCHANGED\n");
    await mkdir(join(root, "nested"), { recursive: true });
    await Bun.write(join(root, "nested", artifactName), "inside");
    await rename(join(root, "nested"), join(root, "nested.real"));
    await symlink(outside, join(root, "nested"));
    const cleaned = await cleanupReceiptArtifacts(
      root,
      [`nested/${artifactName}`],
      []
    );
    expect(cleaned).toBe(false);
    expect(await Bun.file(sentinel).text()).toBe("OUTSIDE_UNCHANGED\n");
  });
});

describe("owned directory cleanup truthfulness", () => {
  test("injected rmdir failure yields recovery_required not rolled_back", async () => {
    const root = await makeRoot(tempDirs);
    const sourceContent = "# Note\n";
    await writeNote(root, "old-note.md", sourceContent);
    const plan = await movePlan(
      "old-note.md",
      "archive/nested/old-note.md",
      sourceContent
    );
    const result = await applyWith(root, plan, {
      onBoundary: async (b) => {
        if (b.kind === "after_target_dirs") {
          throw new Error("injected after target dirs");
        }
      },
      rmdir: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    expect(result.status).toBe("failed_rolled_back");
    expect(result.filesystem.state).toBe("recovery_required");
    expect(await exists(root, "old-note.md")).toBe(true);
    expect(await readNote(root, "old-note.md")).toBe(sourceContent);
    expect(await dirExists(join(root, "archive"))).toBe(true);
  });

  test("successful nested rollback still removes owned dirs", async () => {
    const root = await makeRoot(tempDirs);
    await mkdir(join(root, "keep-me"), { recursive: true });
    await Bun.write(join(root, "keep-me", ".keep"), "x");
    const sourceContent = "# Note\n";
    await writeNote(root, "old-note.md", sourceContent);
    const plan = await movePlan(
      "old-note.md",
      "archive/nested/old-note.md",
      sourceContent
    );
    const result = await applyWith(root, plan, {
      onBoundary: async (b) => {
        if (b.kind === "after_target_dirs") {
          throw new Error("injected after target dirs");
        }
      },
    });
    expect(result.status).toBe("failed_rolled_back");
    expect(result.filesystem.state).toBe("rolled_back");
    expect(await dirExists(join(root, "archive"))).toBe(false);
    expect(await dirExists(join(root, "keep-me"))).toBe(true);
  });

  test("successful commit keeps owned target dirs", async () => {
    const root = await makeRoot(tempDirs);
    const sourceContent = "# Note\n";
    await writeNote(root, "old-note.md", sourceContent);
    const plan = await movePlan(
      "old-note.md",
      "archive/nested/old-note.md",
      sourceContent
    );
    const result = await applyWith(root, plan);
    expect(result.status).toBe("applied");
    expect(await dirExists(join(root, "archive"))).toBe(true);
    expect(await dirExists(join(root, "archive", "nested"))).toBe(true);
    expect(await exists(root, "archive/nested/old-note.md")).toBe(true);
  });

  test("rmdir refuses swapped owned parent symlink to outside empty dir", async () => {
    if (platform() === "win32") return;
    const root = await makeRoot(tempDirs);
    const outside = await makeRoot(tempDirs);
    await mkdir(join(outside, "nested"), { recursive: true });
    const sourceContent = "# Note\n";
    await writeNote(root, "old-note.md", sourceContent);
    const plan = await movePlan(
      "old-note.md",
      "archive/nested/old-note.md",
      sourceContent
    );
    const result = await applyWith(root, plan, {
      onBoundary: async (b) => {
        if (b.kind === "after_target_dirs") {
          await swapParentDirToOutside(root, "archive", outside);
          throw new Error("injected after owned parent symlink swap");
        }
      },
    });
    expect(result.status).toBe("failed_rolled_back");
    expect(result.filesystem.state).toBe("recovery_required");
    expect(await dirExists(join(outside, "nested"))).toBe(true);
    expect(await exists(root, "old-note.md")).toBe(true);
  });
});
