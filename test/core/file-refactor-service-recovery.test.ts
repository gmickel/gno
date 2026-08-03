/**
 * Failure-injection, abort, race, and sync-retry apply-service tests.
 *
 * @module test/core/file-refactor-service-recovery
 */

import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises symlink/lstat/mkdir — fixture only; no Bun symlink helper
import { lstat, mkdir, symlink } from "node:fs/promises";
// node:os platform — skip symlink escape on win32 when needed
import { platform } from "node:os";
// node:path join — no Bun path utils
import { join } from "node:path";

import {
  cleanupReceiptArtifacts,
  resolveCollectionAbsPath,
} from "../../src/core/file-refactor-apply-fs";
import {
  assertContainedExistingPath,
  ensureContainedTargetParents,
  removeOwnedEmptyDirs,
  validateRefactorJournalId,
} from "../../src/core/file-refactor-apply-safety";
import {
  applyFileRefactor,
  createMemoryFileRefactorJournal,
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_SCHEMA_VERSION,
  type FileRefactorBoundaryHook,
} from "../../src/core/file-refactors";
import {
  buildRenamePlan,
  cleanupTempDirs,
  depsFor,
  exists,
  listGnoRfArtifacts,
  makeRoot,
  readNote,
  writeNote,
} from "./file-refactor-service-helpers";

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

async function setupMulti(root: string) {
  const sourceContent = "See [[Old Note]].\n";
  const refA = "A [[Old Note]]\n";
  const refB = "B [[Old Note]]\n";
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
  return { plan, sourceContent, refA, refB };
}

async function assertFullyRestored(
  root: string,
  sourceContent: string,
  refA: string,
  refB: string
): Promise<void> {
  expect(await exists(root, "old-note.md")).toBe(true);
  expect(await exists(root, "new-note.md")).toBe(false);
  expect(await readNote(root, "old-note.md")).toBe(sourceContent);
  expect(await readNote(root, "a.md")).toBe(refA);
  expect(await readNote(root, "b.md")).toBe(refB);
  expect(await listGnoRfArtifacts(root)).toEqual([]);
}

describe("applyFileRefactor failure injection", () => {
  test("inject failure at every stage and commit point restores fully", async () => {
    const boundaries: Array<Parameters<FileRefactorBoundaryHook>[0]> = [];
    const rootProbe = await makeRoot(tempDirs);
    const probe = await setupMulti(rootProbe);
    await applyFileRefactor(
      probe.plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: probe.plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(rootProbe, {
        onBoundary: async (b) => {
          boundaries.push(b);
        },
      })
    );

    const stageAndCommit = boundaries.filter(
      (b) =>
        b.kind === "stage" ||
        b.kind === "after_stage_write" ||
        b.kind === "after_stage_backup" ||
        b.kind === "commit" ||
        b.kind === "before_commit"
    );
    expect(stageAndCommit.length).toBeGreaterThan(5);

    for (const target of stageAndCommit) {
      const root = await makeRoot(tempDirs);
      const { plan, sourceContent, refA, refB } = await setupMulti(root);
      let seen = false;
      const result = await applyFileRefactor(
        plan,
        {
          schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
          planDigest: plan.planDigest,
          confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        },
        depsFor(root, {
          onBoundary: async (b) => {
            if (seen) return;
            if (
              b.kind === target.kind &&
              ("relPath" in b
                ? "relPath" in target && b.relPath === target.relPath
                : true) &&
              ("role" in b ? "role" in target && b.role === target.role : true)
            ) {
              seen = true;
              throw new Error(`injected:${target.kind}`);
            }
          },
        })
      );

      expect(result.status).toBe("failed_rolled_back");
      if (result.filesystem.state === "rolled_back") {
        await assertFullyRestored(root, sourceContent, refA, refB);
      } else {
        expect(result.filesystem.state).toBe("recovery_required");
        expect(result.filesystem.recoveryJournalId).toBeTruthy();
        expect(result.status).not.toBe("applied");
      }
    }
  });

  test("abort before commit returns unchanged; abort during commit finishes apply", async () => {
    const root = await makeRoot(tempDirs);
    const { plan, sourceContent, refA } = await setupMulti(root);
    const ac = new AbortController();
    const before = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, {
        onBoundary: async (b) => {
          if (b.kind === "before_commit") ac.abort();
        },
      }),
      ac.signal
    );
    expect(before.filesystem.state).toBe("unchanged");
    expect(await exists(root, "old-note.md")).toBe(true);
    expect(await readNote(root, "old-note.md")).toBe(sourceContent);
    expect(await readNote(root, "a.md")).toBe(refA);

    const root2 = await makeRoot(tempDirs);
    const setup2 = await setupMulti(root2);
    const ac2 = new AbortController();
    const during = await applyFileRefactor(
      setup2.plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: setup2.plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root2, {
        onBoundary: async (b) => {
          if (b.kind === "commit") ac2.abort();
        },
      }),
      ac2.signal
    );
    expect(during.status).toBe("applied");
    expect(await exists(root2, "new-note.md")).toBe(true);
    expect(await exists(root2, "old-note.md")).toBe(false);
  });

  test("stage write/backup substep failures leave no .gno-rf artifacts", async () => {
    for (const kind of ["after_stage_write", "after_stage_backup"] as const) {
      const root = await makeRoot(tempDirs);
      const { plan, sourceContent, refA, refB } = await setupMulti(root);
      let fired = false;
      const result = await applyFileRefactor(
        plan,
        {
          schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
          planDigest: plan.planDigest,
          confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        },
        depsFor(root, {
          onBoundary: async (b) => {
            if (!fired && b.kind === kind && b.role === "affected") {
              fired = true;
              throw new Error(`injected:${kind}`);
            }
          },
        })
      );
      expect(result.status).toBe("failed_rolled_back");
      expect(result.filesystem.state).toBe("rolled_back");
      await assertFullyRestored(root, sourceContent, refA, refB);
    }
  });

  test("source removal failure and post-commit tamper never report applied", async () => {
    const root = await makeRoot(tempDirs);
    const { plan, sourceContent, refA, refB } = await setupMulti(root);
    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, {
        removePathRequired: async () => {
          throw new Error("EACCES: injected source removal failure");
        },
      })
    );
    expect(result.status).toBe("failed_rolled_back");
    expect(["rolled_back", "recovery_required"]).toContain(
      result.filesystem.state
    );
    if (result.filesystem.state === "rolled_back") {
      await assertFullyRestored(root, sourceContent, refA, refB);
    }

    const root3 = await makeRoot(tempDirs);
    const setup3 = await setupMulti(root3);
    const midTamper = await applyFileRefactor(
      setup3.plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: setup3.plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root3, {
        onBoundary: async (b) => {
          if (b.kind === "after_commit_target" && b.role === "source") {
            await writeNote(root3, "new-note.md", "TAMPERED_TARGET\n");
          }
        },
      })
    );
    expect(midTamper.status).toBe("failed_rolled_back");
    expect(midTamper.filesystem.state).toBe("recovery_required");
    expect(await readNote(root3, "new-note.md")).toBe("TAMPERED_TARGET\n");
    expect(await readNote(root3, "old-note.md")).toBe(setup3.sourceContent);
  });

  test("commit races: occupied target and affected external mutation", async () => {
    const root = await makeRoot(tempDirs);
    const { plan, sourceContent, refA, refB } = await setupMulti(root);
    const occupied = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, {
        onBoundary: async (b) => {
          if (b.kind === "commit" && b.role === "source") {
            await writeNote(root, "new-note.md", "EXTERNAL_TARGET\n");
          }
        },
      })
    );
    expect(occupied.status).toBe("failed_rolled_back");
    expect(occupied.filesystem.state).not.toBe("committed");
    expect(await readNote(root, "new-note.md")).toBe("EXTERNAL_TARGET\n");
    expect(await readNote(root, "old-note.md")).toBe(sourceContent);
    expect(await readNote(root, "a.md")).toBe(refA);
    expect(await readNote(root, "b.md")).toBe(refB);

    const root2 = await makeRoot(tempDirs);
    const setup2 = await setupMulti(root2);
    const mutated = await applyFileRefactor(
      setup2.plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: setup2.plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root2, {
        onBoundary: async (b) => {
          if (
            b.kind === "commit" &&
            b.role === "affected" &&
            b.relPath === "a.md"
          ) {
            await writeNote(root2, "a.md", "EXTERNAL_A\n");
          }
        },
      })
    );
    expect(mutated.status).toBe("failed_rolled_back");
    expect(mutated.filesystem.state).not.toBe("committed");
    expect(await readNote(root2, "a.md")).toBe("EXTERNAL_A\n");
    expect(await exists(root2, "new-note.md")).toBe(false);
  });

  test("rollback operation failure returns typed recovery_required without throw", async () => {
    const root = await makeRoot(tempDirs);
    const { plan } = await setupMulti(root);
    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, {
        onBoundary: async (b) => {
          if (b.kind === "commit" && b.role === "source") {
            throw new Error("injected commit failure");
          }
          if (b.kind === "rollback") {
            throw new Error("injected rollback failure");
          }
        },
      })
    );
    expect(result.status).toBe("failed_rolled_back");
    expect(result.filesystem.state).toBe("recovery_required");
    if (result.status === "failed_rolled_back") {
      expect(result.reasonCode).toBe("rollback_recovery_required");
    }
  });

  test("committing receipt exposes artifact metadata without secret bodies", async () => {
    const root = await makeRoot(tempDirs);
    const secret = "SECRET_BODY_DO_NOT_JOURNAL\n";
    await writeNote(root, "old-note.md", "# Old\n");
    await writeNote(root, "ref.md", `See [[Old Note]] ${secret}`);
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [{ relPath: "ref.md", content: `See [[Old Note]] ${secret}` }],
    });
    const journal = createMemoryFileRefactorJournal();
    let committingSnapshot: string | null = null;
    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, {
        journal,
        onBoundary: async (b) => {
          if (
            b.kind === "commit" &&
            b.role === "source" &&
            !committingSnapshot
          ) {
            const receipt = await journal.getLatestReceiptByPlanDigest(
              plan.planDigest
            );
            committingSnapshot = JSON.stringify(receipt);
            throw new Error("injected during commit for receipt inspect");
          }
        },
      })
    );
    expect(
      result.filesystem.state === "rolled_back" ||
        result.filesystem.state === "recovery_required"
    ).toBe(true);
    const snapshot = committingSnapshot ?? "";
    expect(snapshot.length).toBeGreaterThan(0);
    expect(snapshot.includes("SECRET_BODY")).toBe(false);
    expect(snapshot.includes("gno-rf-stage")).toBe(true);
    expect(snapshot.includes("gno-rf-backup")).toBe(true);
    const receipt = await journal.getLatestReceiptByPlanDigest(plan.planDigest);
    expect(receipt?.fileEntries.some((e) => e.stageRelPath)).toBe(true);
    expect(receipt?.fileEntries.some((e) => e.backupRelPath)).toBe(true);
    if (result.filesystem.state === "recovery_required") {
      expect(
        receipt?.fileEntries.every(
          (e) => e.stageRelPath || e.backupRelPath || e.status !== "pending"
        )
      ).toBe(true);
    }
  });
});

describe("applyFileRefactor sync pending and idempotent retry", () => {
  test("sync failure commits files and retry only syncs", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old-note.md", "# Old\n");
    await writeNote(root, "ref.md", "See [[Old Note]].\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [{ relPath: "ref.md", content: "See [[Old Note]].\n" }],
    });

    const journal = createMemoryFileRefactorJournal();
    let syncCalls = 0;
    let mutateBoundaries = 0;
    const sharedDeps = depsFor(root, {
      journal,
      syncAfterCommit: async () => {
        syncCalls += 1;
        if (syncCalls === 1) throw new Error("sync down");
      },
      onBoundary: async () => {
        mutateBoundaries += 1;
      },
    });

    const first = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      sharedDeps
    );
    expect(first.status).toBe("applied_with_sync_pending");
    expect(await exists(root, "new-note.md")).toBe(true);
    expect(await exists(root, "old-note.md")).toBe(false);
    const committedRef = await readNote(root, "ref.md");
    const boundariesAfterFirst = mutateBoundaries;

    const second = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      sharedDeps
    );
    expect(second.status).toBe("applied");
    expect(syncCalls).toBe(2);
    expect(mutateBoundaries).toBe(boundariesAfterFirst);
    expect(await readNote(root, "ref.md")).toBe(committedRef);

    const third = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      sharedDeps
    );
    expect(third.status).toBe("applied");
    expect(syncCalls).toBe(2);
    expect(mutateBoundaries).toBe(boundariesAfterFirst);
  });

  test("bad confirmation/digest against existing applied/sync_pending never syncs", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old-note.md", "# Old\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [],
    });
    const journal = createMemoryFileRefactorJournal();
    let syncCalls = 0;
    const deps = depsFor(root, {
      journal,
      syncAfterCommit: async () => {
        syncCalls += 1;
        if (syncCalls === 1) throw new Error("sync down");
      },
    });
    const pending = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      deps
    );
    expect(pending.status).toBe("applied_with_sync_pending");
    const syncBefore = syncCalls;

    const badConfirm = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: "yes" as typeof FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      deps
    );
    expect(badConfirm.status).toBe("unsupported");
    expect(badConfirm.filesystem.state).toBe("unchanged");
    expect(syncCalls).toBe(syncBefore);

    const badDigest = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: "0".repeat(64),
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      deps
    );
    expect(badDigest.status).toBe("stale_plan");
    expect(badDigest.filesystem.state).toBe("unchanged");
    expect(syncCalls).toBe(syncBefore);
  });

  test("uncertain prior phases return recovery_required with zero mutation", async () => {
    for (const phase of ["staging", "rolling_back"] as const) {
      const root = await makeRoot(tempDirs);
      await writeNote(root, "old-note.md", "# Old\n");
      const plan = await buildRenamePlan({
        sourceRel: "old-note.md",
        targetRel: "new-note.md",
        sourceContent: "# Old\n",
        referrers: [],
      });
      const journal = createMemoryFileRefactorJournal();
      const prepared = await journal.createPreparedReceipt({
        journalId: `preseed-${phase}`,
        planDigest: plan.planDigest,
        collection: "notes",
        operation: "rename",
        sourceRelPath: "old-note.md",
        targetRelPath: "new-note.md",
        fileEntries: [
          {
            role: "source",
            relPath: "old-note.md",
            stageRelPath: "new-note.md.gno-rf-stage.x",
            backupRelPath: "old-note.md.gno-rf-backup.x",
            status: "pending",
          },
        ],
        createdAtMs: 1,
      });
      await journal.advanceReceipt(prepared.journalId, {
        phase: "staging",
        updatedAtMs: 2,
      });
      if (phase === "rolling_back") {
        await journal.advanceReceipt(prepared.journalId, {
          phase: "rolling_back",
          updatedAtMs: 3,
        });
      }
      let boundaries = 0;
      const result = await applyFileRefactor(
        plan,
        {
          schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
          planDigest: plan.planDigest,
          confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        },
        depsFor(root, {
          journal,
          onBoundary: async () => {
            boundaries += 1;
          },
        })
      );
      expect(result.filesystem.state).toBe("recovery_required");
      expect(boundaries).toBe(0);
      expect(await exists(root, "old-note.md")).toBe(true);
      expect(await exists(root, "new-note.md")).toBe(false);
    }
  });

  test("journal receipt is content-free", async () => {
    const root = await makeRoot(tempDirs);
    const body = "SECRET_BODY [[Old Note]] SECRET\n";
    await writeNote(root, "old-note.md", "# Old\n");
    await writeNote(root, "ref.md", body);
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [{ relPath: "ref.md", content: body }],
    });
    const journal = createMemoryFileRefactorJournal();
    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, { journal })
    );
    expect(result.status).toBe("applied");
    const receipt = await journal.getLatestReceiptByPlanDigest(plan.planDigest);
    expect(receipt).not.toBeNull();
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("SECRET_BODY");
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("[[Old Note]]");
    expect(serialized).toContain(plan.planDigest);
    for (const entry of receipt?.fileEntries ?? []) {
      expect(entry.originalFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.stageRelPath).toContain("gno-rf-stage");
      expect(entry.backupRelPath).toContain("gno-rf-backup");
    }
  });

  test("runSyncOnly journal advance failure still returns sync_pending", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old-note.md", "# Old\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [],
    });
    const journal = createMemoryFileRefactorJournal();
    const first = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, {
        journal,
        syncAfterCommit: async () => {
          throw new Error("sync down");
        },
      })
    );
    expect(first.status).toBe("applied_with_sync_pending");

    const originalAdvance = journal.advanceReceipt.bind(journal);
    journal.advanceReceipt = async () => {
      throw new Error("journal advance failed");
    };
    const retry = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, {
        journal,
        syncAfterCommit: async () => undefined,
      })
    );
    expect(retry.status).toBe("applied_with_sync_pending");
    expect(retry.filesystem.recoveryJournalId).toBeTruthy();
    journal.advanceReceipt = originalAdvance;
  });
});

describe("applyFileRefactor structural and symlink safety", () => {
  test("malformed self-digested canApply plan fails unchanged before staging", async () => {
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
    const brokenMaterial = {
      ...plan,
      planDigest: undefined as unknown as string,
      affectedDocuments: [
        ...plan.affectedDocuments,
        {
          ...plan.affectedDocuments[0],
          uri: "gno://notes/dup.md",
          relPath: "old-note.md",
        },
      ],
      preconditions: {
        ...plan.preconditions,
        affectedContentFingerprints: [
          ...plan.preconditions.affectedContentFingerprints,
          { uri: "gno://notes/extra.md", fingerprint: "a".repeat(64) },
        ],
      },
    };
    const { planDigest: _drop, ...rest } = brokenMaterial as typeof plan;
    const digest = await computeFileRefactorPlanDigest(rest);
    const broken = { ...rest, planDigest: digest, canApply: true as const };
    let boundaries = 0;
    const result = await applyFileRefactor(
      broken,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: broken.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, {
        onBoundary: async () => {
          boundaries += 1;
        },
      })
    );
    expect(result.status).toBe("unsupported");
    expect(result.filesystem.state).toBe("unchanged");
    expect(boundaries).toBe(0);
    expect(await exists(root, "new-note.md")).toBe(false);
  });

  test("symlink escape through collection-internal link is rejected", async () => {
    if (platform() === "win32") return;
    const root = await makeRoot(tempDirs);
    const outside = await makeRoot(tempDirs);
    await writeNote(outside, "secret.md", "OUTSIDE\n");
    await writeNote(root, "old-note.md", "# Old\n");
    await symlink(join(outside, "secret.md"), join(root, "escape.md"));
    const plan = await buildRenamePlan({
      sourceRel: "escape.md",
      targetRel: "new-note.md",
      sourceContent: "OUTSIDE\n",
      referrers: [],
    });
    // Force fingerprints to match the symlink target bytes so only containment fails.
    const { computeFileRefactorPlanDigest, fingerprintUtf8Content } =
      await import("../../src/core/file-refactor-contract");
    const fp = await fingerprintUtf8Content("OUTSIDE\n");
    const material = {
      ...plan,
      canApply: true as const,
      source: {
        ...plan.source,
        uri: "gno://notes/escape.md",
        relPath: "escape.md",
      },
      affectedDocuments: plan.affectedDocuments.map((doc) =>
        doc.relPath === "old-note.md"
          ? {
              ...doc,
              uri: "gno://notes/escape.md",
              relPath: "escape.md",
              contentFingerprint: fp,
            }
          : doc
      ),
      preconditions: {
        ...plan.preconditions,
        sourceContentFingerprint: fp,
        affectedContentFingerprints: [
          { uri: "gno://notes/escape.md", fingerprint: fp },
        ],
      },
      safety: { ...plan.safety, blockingReasonCodes: [] },
    };
    const { planDigest: _d, ...rest } = material;
    const digest = await computeFileRefactorPlanDigest(rest);
    const escapePlan = { ...rest, planDigest: digest };
    const result = await applyFileRefactor(
      escapePlan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: escapePlan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root)
    );
    expect(result.status).toBe("unsupported");
    expect(result.filesystem.state).toBe("unchanged");
    expect(await exists(root, "new-note.md")).toBe(false);
  });
});

async function dirExists(absPath: string): Promise<boolean> {
  try {
    return (await lstat(absPath)).isDirectory();
  } catch {
    return false;
  }
}

describe("applyFileRefactor artifact and directory safety", () => {
  test("pre-existing stage/backup symlink cannot escape collection", async () => {
    if (platform() === "win32") return;
    const root = await makeRoot(tempDirs);
    const outside = await makeRoot(tempDirs);
    const outsideSentinel = join(outside, "sentinel.md");
    await Bun.write(outsideSentinel, "OUTSIDE_UNCHANGED\n");
    await writeNote(root, "old-note.md", "# Old\n");
    await writeNote(root, "ref.md", "See [[Old Note]].\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [{ relPath: "ref.md", content: "See [[Old Note]].\n" }],
    });
    const journalId = "safe-journal-id";
    await symlink(
      outsideSentinel,
      join(root, `old-note.md.gno-rf-stage.${journalId}.1`)
    );
    await symlink(
      outsideSentinel,
      join(root, `old-note.md.gno-rf-backup.${journalId}.1`)
    );
    // Affected is index 0, source is last — plant source artifacts at index 1.
    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, { createJournalId: () => journalId })
    );
    expect(result.status).toBe("failed_rolled_back");
    expect(result.filesystem.state).not.toBe("committed");
    expect(await Bun.file(outsideSentinel).text()).toBe("OUTSIDE_UNCHANGED\n");
    expect(await exists(root, "old-note.md")).toBe(true);
    expect(await exists(root, "new-note.md")).toBe(false);
    expect(await readNote(root, "ref.md")).toBe("See [[Old Note]].\n");
  });

  test("rollback symlink-swap on source leaves outside file unchanged", async () => {
    if (platform() === "win32") return;
    const root = await makeRoot(tempDirs);
    const outside = await makeRoot(tempDirs);
    const outsideSentinel = join(outside, "sentinel.md");
    await Bun.write(outsideSentinel, "OUTSIDE_UNCHANGED\n");
    await writeNote(root, "old-note.md", "# Old\n");
    await writeNote(root, "ref.md", "See [[Old Note]].\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [{ relPath: "ref.md", content: "See [[Old Note]].\n" }],
    });
    const { removePathRequired: realRemove } =
      await import("../../src/core/file-ops");
    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, {
        removePathRequired: async (path) => {
          await realRemove(path);
          if (path.endsWith("old-note.md")) {
            await symlink(outsideSentinel, path);
            throw new Error("injected after source unlink + symlink swap");
          }
        },
      })
    );
    expect(result.status).toBe("failed_rolled_back");
    expect(
      result.filesystem.state === "rolled_back" ||
        result.filesystem.state === "recovery_required"
    ).toBe(true);
    expect(await Bun.file(outsideSentinel).text()).toBe("OUTSIDE_UNCHANGED\n");
    if (result.filesystem.state === "rolled_back") {
      expect(await exists(root, "old-note.md")).toBe(true);
      expect(await readNote(root, "old-note.md")).toBe("# Old\n");
      expect(await exists(root, "new-note.md")).toBe(false);
    }
  });

  test("nested move abort before commit leaves no archive directory", async () => {
    const root = await makeRoot(tempDirs);
    const sourceContent = "# Note\n";
    const ref = "See [[Old Note]].\n";
    await writeNote(root, "old-note.md", sourceContent);
    await writeNote(root, "ref.md", ref);
    const { planFileRefactorImpact } =
      await import("../../src/core/file-refactors");
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
    const ac = new AbortController();
    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, {
        onBoundary: async (b) => {
          if (b.kind === "before_commit") ac.abort();
        },
      }),
      ac.signal
    );
    expect(result.status).toBe("conflict");
    expect(result.filesystem.state).toBe("unchanged");
    expect(await dirExists(join(root, "archive"))).toBe(false);
    expect(await exists(root, "old-note.md")).toBe(true);
    expect(await listGnoRfArtifacts(root)).toEqual([]);
  });

  test("failure after target-dir creation restores source and removes only new empty dirs", async () => {
    const root = await makeRoot(tempDirs);
    await mkdir(join(root, "keep-me"), { recursive: true });
    await Bun.write(join(root, "keep-me", ".keep"), "x");
    const sourceContent = "# Note\n";
    await writeNote(root, "old-note.md", sourceContent);
    const { planFileRefactorImpact } =
      await import("../../src/core/file-refactors");
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
        uri: "gno://notes/archive/nested/old-note.md",
        relPath: "archive/nested/old-note.md",
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
      ],
      targetOccupied: false,
    });
    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, {
        onBoundary: async (b) => {
          if (b.kind === "after_target_dirs") {
            throw new Error("injected after target dirs");
          }
        },
      })
    );
    expect(result.status).toBe("failed_rolled_back");
    expect(result.filesystem.state).toBe("rolled_back");
    expect(await exists(root, "old-note.md")).toBe(true);
    expect(await readNote(root, "old-note.md")).toBe(sourceContent);
    expect(await dirExists(join(root, "archive"))).toBe(false);
    expect(await dirExists(join(root, "keep-me"))).toBe(true);
  });

  test("receipt cleanup with traversal path never touches outside sentinel", async () => {
    const root = await makeRoot(tempDirs);
    const outside = await makeRoot(tempDirs);
    const sentinel = join(outside, "sentinel.md");
    await Bun.write(sentinel, "OUTSIDE_UNCHANGED\n");
    const cleaned = await cleanupReceiptArtifacts(
      root,
      ["../../sentinel.md.gno-rf-stage.x"],
      [undefined]
    );
    expect(cleaned).toBe(false);
    expect(await Bun.file(sentinel).text()).toBe("OUTSIDE_UNCHANGED\n");
  });

  test("receipt cleanup failure seam returns false not safe", async () => {
    const root = await makeRoot(tempDirs);
    await Bun.write(join(root, "note.md.gno-rf-stage.tok"), "stage");
    const cleaned = await cleanupReceiptArtifacts(
      root,
      ["note.md.gno-rf-stage.tok"],
      [],
      async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
    );
    expect(cleaned).toBe(false);
  });

  test("malicious journalId is rejected before staging", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old-note.md", "# Old\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [],
    });
    let boundaries = 0;
    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, {
        createJournalId: () => "../evil",
        onBoundary: async () => {
          boundaries += 1;
        },
      })
    );
    expect(result.status).toBe("unsupported");
    expect(result.filesystem.state).toBe("unchanged");
    expect(boundaries).toBe(0);
    expect(() => validateRefactorJournalId("ok-id")).not.toThrow();
    expect(() => validateRefactorJournalId("../evil")).toThrow();
  });

  test("affected URI collection mismatch fails closed before staging", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old-note.md", "# Old\n");
    await writeNote(root, "ref.md", "See [[Old Note]].\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [{ relPath: "ref.md", content: "See [[Old Note]].\n" }],
    });
    const { computeFileRefactorPlanDigest } =
      await import("../../src/core/file-refactor-contract");
    const material = {
      ...plan,
      planDigest: undefined as unknown as string,
      canApply: true as const,
      affectedDocuments: plan.affectedDocuments.map((doc) =>
        doc.relPath === "ref.md" ? { ...doc, uri: "gno://other/ref.md" } : doc
      ),
      preconditions: {
        ...plan.preconditions,
        affectedContentFingerprints:
          plan.preconditions.affectedContentFingerprints.map((entry) =>
            entry.uri.endsWith("/ref.md")
              ? { ...entry, uri: "gno://other/ref.md" }
              : entry
          ),
      },
      safety: { ...plan.safety, blockingReasonCodes: [] },
    };
    const { planDigest: _drop, ...rest } = material as typeof plan;
    const digest = await computeFileRefactorPlanDigest(rest);
    const broken = { ...rest, planDigest: digest };
    let boundaries = 0;
    const result = await applyFileRefactor(
      broken,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: broken.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, {
        onBoundary: async () => {
          boundaries += 1;
        },
      })
    );
    expect(result.status).toBe("unsupported");
    expect(result.filesystem.state).toBe("unchanged");
    expect(boundaries).toBe(0);
  });

  test("target parent containment helper fails closed on symlink swap", async () => {
    if (platform() === "win32") return;
    const root = await makeRoot(tempDirs);
    const outside = await makeRoot(tempDirs);
    await Bun.write(join(outside, "x.md"), "out");
    const created = await ensureContainedTargetParents(
      join(root, "archive", "nested", "note.md"),
      root
    );
    expect(created.length).toBeGreaterThan(0);
    // Swap archive for an escaping symlink after creation.
    await removeOwnedEmptyDirs(created, root);
    await symlink(outside, join(root, "archive"));
    let assertFailed = false;
    try {
      await assertContainedExistingPath(root, join(root, "archive"));
    } catch {
      assertFailed = true;
    }
    expect(assertFailed).toBe(true);
    let ensureFailed = false;
    try {
      await ensureContainedTargetParents(
        join(root, "archive", "nested", "note.md"),
        root
      );
    } catch {
      ensureFailed = true;
    }
    expect(ensureFailed).toBe(true);
  });

  test("uncertain retry with injected cleanup failure returns recovery_required", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old-note.md", "# Old\n");
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [],
    });
    const journal = createMemoryFileRefactorJournal();
    const prepared = await journal.createPreparedReceipt({
      journalId: "preseed-aborted",
      planDigest: plan.planDigest,
      collection: "notes",
      operation: "rename",
      sourceRelPath: "old-note.md",
      targetRelPath: "new-note.md",
      fileEntries: [
        {
          role: "source",
          relPath: "old-note.md",
          stageRelPath: "old-note.md.gno-rf-stage.x",
          backupRelPath: "old-note.md.gno-rf-backup.x",
          status: "pending",
        },
      ],
      createdAtMs: 1,
    });
    await journal.advanceReceipt(prepared.journalId, {
      phase: "staging",
      updatedAtMs: 2,
    });
    await journal.advanceReceipt(prepared.journalId, {
      phase: "aborted",
      filesystemState: "unchanged",
      updatedAtMs: 3,
    });
    await Bun.write(
      resolveCollectionAbsPath(root, "old-note.md.gno-rf-stage.x"),
      "leftover"
    );
    const result = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      depsFor(root, {
        journal,
        removePathRequired: async () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      })
    );
    expect(result.filesystem.state).toBe("recovery_required");
    expect(await exists(root, "old-note.md")).toBe(true);
    expect(await exists(root, "new-note.md")).toBe(false);
  });
});
