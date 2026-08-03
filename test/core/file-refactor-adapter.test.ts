/**
 * Contract tests for the transport-neutral file-refactor adapter (SDK/MCP).
 */

import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises for mkdir (structure ops; no Bun equivalent)
import { mkdir } from "node:fs/promises";
// node:os tmpdir — no Bun equivalent
import { tmpdir } from "node:os";
// node:path join — no Bun equivalent
import { join } from "node:path";

import {
  applyCanonicalFileRefactor,
  assertFileRefactorSyncConverged,
  buildCanonicalRefactorPlan,
  buildDurableFileRefactorApplyDeps,
  collectionRefactorLockPath,
  createMemoryFileRefactorJournal,
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_COLLECTION_LOCK_NAME,
  FILE_REFACTOR_SCHEMA_VERSION,
  parseRefactorApplyConfirmation,
  resolveRenameTarget,
} from "../../src/core/file-refactors";
import {
  cleanupTempDirs,
  makeRoot,
  writeNote,
} from "../core/file-refactor-service-helpers";

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

describe("file-refactor adapter (transport-neutral)", () => {
  test("collection lock path matches REST/SDK convention", () => {
    expect(collectionRefactorLockPath("/vault/notes")).toBe(
      join("/vault/notes", FILE_REFACTOR_COLLECTION_LOCK_NAME)
    );
  });

  test("requires exact apply confirmation before mutation", () => {
    expect(parseRefactorApplyConfirmation({})).toEqual(
      expect.objectContaining({ error: "INVALID_INPUT" })
    );
    expect(
      parseRefactorApplyConfirmation({
        planDigest: "d".repeat(64),
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      })
    ).toEqual(expect.objectContaining({ error: "INVALID_INPUT" }));
    expect(
      parseRefactorApplyConfirmation({
        planDigest: "d".repeat(64),
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      })
    ).toEqual({
      planDigest: "d".repeat(64),
      confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
    });
  });

  test("refuses durable deps without a journal store", () => {
    expect(() =>
      buildDurableFileRefactorApplyDeps({
        collection: {
          name: "notes",
          path: tmpdir(),
          pattern: "**/*",
          include: [],
          exclude: [],
        },
        store: {},
        syncAfterCommit: async () => undefined,
      })
    ).toThrow(/Durable file-refactor journal/);
  });

  test("reported sync file errors are not convergence", () => {
    expect(() =>
      assertFileRefactorSyncConverged({ filesErrored: 1, errors: [] })
    ).toThrow(/convergence reported sync errors/);
    expect(() =>
      assertFileRefactorSyncConverged({ filesErrored: 0, errors: [{}] })
    ).toThrow(/convergence reported sync errors/);
    expect(() =>
      assertFileRefactorSyncConverged({ filesErrored: 0, errors: [] })
    ).not.toThrow();
  });

  test("preview then exact apply succeeds; wrong digest is stale_plan", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old.md", "# Old\n");
    const collection = {
      name: "notes",
      path: root,
      pattern: "**/*",
      include: [] as string[],
      exclude: [] as string[],
    };
    const doc = {
      id: 1,
      uri: "gno://notes/old.md",
      relPath: "old.md",
      collection: "notes",
      title: "Old",
      mirrorHash: "m".repeat(64),
    };
    const target = resolveRenameTarget({
      collection: "notes",
      currentRelPath: "old.md",
      nextName: "new.md",
    });
    const plan = await buildCanonicalRefactorPlan({
      operation: "rename",
      doc,
      collection,
      sourceFullPath: join(root, "old.md"),
      target,
      store: {},
      sourceEditable: true,
    });
    expect(plan.canApply).toBe(true);
    expect(plan.planDigest.length).toBe(64);

    const journal = createMemoryFileRefactorJournal();
    const deps = {
      collectionRoot: root,
      lockPath: collectionRefactorLockPath(root),
      journal,
      syncAfterCommit: async () => undefined,
      acquireLock: async () => ({ release: async () => undefined }),
    };

    const stale = await applyCanonicalFileRefactor({
      plan,
      confirmation: {
        planDigest: "0".repeat(64),
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      },
      deps,
    });
    expect(stale.status).toBe("stale_plan");
    expect(await Bun.file(join(root, "old.md")).exists()).toBe(true);

    const applied = await applyCanonicalFileRefactor({
      plan,
      confirmation: {
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      },
      deps,
    });
    expect(applied.status).toBe("applied");
    expect(await Bun.file(join(root, "new.md")).exists()).toBe(true);
    expect(await Bun.file(join(root, "old.md")).exists()).toBe(false);
  });

  test("occupied target and capability denial stay typed terminal states", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old.md", "# Old\n");
    await writeNote(root, "taken.md", "# Taken\n");
    const collection = {
      name: "notes",
      path: root,
      pattern: "**/*",
      include: [] as string[],
      exclude: [] as string[],
    };
    const doc = {
      id: 1,
      uri: "gno://notes/old.md",
      relPath: "old.md",
      collection: "notes",
      title: "Old",
      mirrorHash: "m".repeat(64),
    };
    const occupiedPlan = await buildCanonicalRefactorPlan({
      operation: "rename",
      doc,
      collection,
      sourceFullPath: join(root, "old.md"),
      target: resolveRenameTarget({
        collection: "notes",
        currentRelPath: "old.md",
        nextName: "taken.md",
      }),
      store: {},
      sourceEditable: true,
    });
    expect(occupiedPlan.canApply).toBe(false);

    const deniedPlan = await buildCanonicalRefactorPlan({
      operation: "rename",
      doc,
      collection,
      sourceFullPath: join(root, "old.md"),
      target: resolveRenameTarget({
        collection: "notes",
        currentRelPath: "old.md",
        nextName: "fresh.md",
      }),
      store: {},
      sourceEditable: false,
    });
    expect(deniedPlan.canApply).toBe(false);

    const journal = createMemoryFileRefactorJournal();
    const deps = {
      collectionRoot: root,
      lockPath: collectionRefactorLockPath(root),
      journal,
      syncAfterCommit: async () => undefined,
      acquireLock: async () => ({ release: async () => undefined }),
    };

    const occupiedResult = await applyCanonicalFileRefactor({
      plan: occupiedPlan,
      confirmation: {
        planDigest: occupiedPlan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      },
      deps,
    });
    expect(["conflict", "unsupported"]).toContain(occupiedResult.status);
    if (
      occupiedResult.status === "conflict" ||
      occupiedResult.status === "unsupported"
    ) {
      expect(occupiedResult.reasonCode).toBe("occupied_target");
    }

    const deniedResult = await applyCanonicalFileRefactor({
      plan: deniedPlan,
      confirmation: {
        planDigest: deniedPlan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      },
      deps,
    });
    expect(deniedResult.status).toBe("unsupported");
    if (deniedResult.status === "unsupported") {
      expect(["capability_denied", "read_only_document"]).toContain(
        deniedResult.reasonCode
      );
    }
  });

  test("sync failure after commit returns applied_with_sync_pending", async () => {
    const root = await makeRoot(tempDirs);
    await mkdir(join(root, "subdir"), { recursive: true });
    await writeNote(root, "old.md", "# Old\n");
    const collection = {
      name: "notes",
      path: root,
      pattern: "**/*",
      include: [] as string[],
      exclude: [] as string[],
    };
    const plan = await buildCanonicalRefactorPlan({
      operation: "rename",
      doc: {
        id: 1,
        uri: "gno://notes/old.md",
        relPath: "old.md",
        collection: "notes",
        title: "Old",
        mirrorHash: "m".repeat(64),
      },
      collection,
      sourceFullPath: join(root, "old.md"),
      target: resolveRenameTarget({
        collection: "notes",
        currentRelPath: "old.md",
        nextName: "renamed.md",
      }),
      store: {},
      sourceEditable: true,
    });

    const journal = createMemoryFileRefactorJournal();
    const result = await applyCanonicalFileRefactor({
      plan,
      confirmation: {
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
      },
      deps: {
        collectionRoot: root,
        lockPath: collectionRefactorLockPath(root),
        journal,
        syncAfterCommit: async () => {
          throw new Error("sync boom");
        },
        acquireLock: async () => ({ release: async () => undefined }),
      },
    });

    expect(result.status).toBe("applied_with_sync_pending");
    if (result.status === "applied_with_sync_pending") {
      expect(result.indexConvergence.state).toBe("pending");
      expect(result.filesystem.state).toBe("committed");
    }
    expect(await Bun.file(join(root, "renamed.md")).exists()).toBe(true);
  });
});
