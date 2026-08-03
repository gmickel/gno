/**
 * Deterministic adversarial proofs for reference-safe rename/move (fn-60.9).
 *
 * Extends the shared fixture matrix; does not change public behavior.
 *
 * @module test/core/file-refactor-adversarial
 */

import { afterEach, describe, expect, test } from "bun:test";
// node:path join — no Bun path utils
import { join } from "node:path";

import { acquireWriteLock } from "../../src/core/file-lock";
import {
  applyDestinationOnlyEdit,
  applyFileRefactor,
  createMemoryFileRefactorJournal,
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_SCHEMA_VERSION,
  fingerprintUtf8Content,
  isContentPreservedOutsideSpan,
  planFileRefactorImpact,
} from "../../src/core/file-refactors";
import {
  fixtureToPlannerInput,
  plannerDriveFixtures,
} from "./file-refactor-planner-fixtures";
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
const UNRELATED = "UNRELATED_SENTINEL_BYTES_ζ_🔒\nkeep me\n";

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

async function snapshotTree(
  root: string
): Promise<Map<string, { fingerprint: string; bytes: string }>> {
  const glob = new Bun.Glob("**/*");
  const out = new Map<string, { fingerprint: string; bytes: string }>();
  for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
    const bytes = await Bun.file(join(root, rel)).text();
    out.set(rel, {
      bytes,
      fingerprint: await fingerprintUtf8Content(bytes),
    });
  }
  return out;
}

function assertTreeUnchanged(
  before: Map<string, { fingerprint: string; bytes: string }>,
  after: Map<string, { fingerprint: string; bytes: string }>
): void {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [rel, prior] of before) {
    const next = after.get(rel);
    expect(next?.fingerprint).toBe(prior.fingerprint);
    expect(next?.bytes).toBe(prior.bytes);
  }
}

describe("adversarial link grammar via shared fixtures", () => {
  test("live planner classifies every planner-drive fixture", async () => {
    const fixtures = plannerDriveFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(16);

    for (const fixture of fixtures) {
      const plan = await planFileRefactorImpact(fixtureToPlannerInput(fixture));
      const referringRel = fixture.planner?.referringRelPath ?? "referrer.md";
      const examined = plan.examinedReferences.filter(
        (ref) => ref.documentRelPath === referringRel
      );
      expect(examined.length).toBeGreaterThanOrEqual(1);

      if (fixture.classification === "rewriteable") {
        const rewriteable = examined.find(
          (ref) => ref.classification === "rewriteable"
        );
        expect(rewriteable).toBeDefined();
        expect(rewriteable?.edit).toBeDefined();
        if (fixture.planner?.expectedProposedDestination) {
          expect(rewriteable?.proposedDestination).toBe(
            fixture.planner.expectedProposedDestination
          );
        }
        const after = applyDestinationOnlyEdit(
          fixture.content,
          rewriteable!.edit!
        );
        expect(
          isContentPreservedOutsideSpan(
            fixture.content,
            after,
            rewriteable!.edit!
          )
        ).toBe(true);
        for (const fragment of fixture.mustPreserve) {
          expect(after.includes(fragment)).toBe(true);
        }
        expect(plan.canApply).toBe(true);
      } else {
        const match =
          examined.find((ref) => ref.reasonCode === fixture.reasonCode) ??
          examined.find((ref) => ref.classification === fixture.classification);
        expect(match?.classification).toBe(fixture.classification);
        if (fixture.reasonCode) {
          expect(match?.reasonCode).toBe(fixture.reasonCode);
        }
        expect(match?.edit).toBeUndefined();
        for (const fragment of fixture.mustPreserve) {
          expect(fixture.content.includes(fragment)).toBe(true);
        }
        if (
          fixture.classification === "ambiguous" ||
          fixture.classification === "malformed" ||
          fixture.classification === "unsupported"
        ) {
          expect(plan.canApply).toBe(false);
        }
      }
    }
  });
});

describe("adversarial apply: stale-plan, lock, rollback, sync-pending", () => {
  test("composite grammar apply leaves unrelated bytes byte-exact", async () => {
    const root = await makeRoot(tempDirs);
    const sourceContent =
      "Title\nSelf [[Old Note#A]] and [self](old-note.md).\n";
    const refContent = [
      "Intro",
      "Wiki [[Old Note|Alias]] and frag [[Old Note#Heading]].",
      'MD [Label](old-note.md "Title") and angle [x](<old-note.md#frag>).',
      "Relative sibling [r](./old-note.md) plus other [o](unrelated.md).",
      "Fence:",
      "```md",
      "[[Old Note]]",
      "```",
      "",
    ].join("\n");
    await writeNote(root, "old-note.md", sourceContent);
    await writeNote(root, "referrer.md", refContent);
    await writeNote(root, "unrelated.md", UNRELATED);
    const unrelatedFp = await fingerprintUtf8Content(UNRELATED);

    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent,
      referrers: [{ relPath: "referrer.md", content: refContent }],
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
    expect(await exists(root, "new-note.md")).toBe(true);
    expect(await exists(root, "old-note.md")).toBe(false);
    const afterRef = await readNote(root, "referrer.md");
    expect(afterRef).toContain("[[New Note|Alias]]");
    expect(afterRef).toContain("[[New Note#Heading]]");
    expect(afterRef).toContain('[Label](new-note.md "Title")');
    expect(afterRef).toContain("[x](<new-note.md#frag>)");
    expect(afterRef).toContain("[r](./new-note.md)");
    expect(afterRef).toContain("[o](unrelated.md)");
    expect(afterRef).toContain("```md\n[[Old Note]]\n```");
    expect(await readNote(root, "unrelated.md")).toBe(UNRELATED);
    expect(
      await fingerprintUtf8Content(await readNote(root, "unrelated.md"))
    ).toBe(unrelatedFp);
    expect(await listGnoRfArtifacts(root)).toEqual([]);
  });

  test("stale source fingerprint rejects with zero mutation including unrelated", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old-note.md", "# Old\n");
    await writeNote(root, "ref.md", "See [[Old Note]].\n");
    await writeNote(root, "unrelated.md", UNRELATED);
    const before = await snapshotTree(root);
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [{ relPath: "ref.md", content: "See [[Old Note]].\n" }],
    });
    await writeNote(root, "old-note.md", "# Changed\n");
    const afterStaleWrite = await snapshotTree(root);

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
    expect(result.filesystem.state).toBe("unchanged");
    const after = await snapshotTree(root);
    assertTreeUnchanged(afterStaleWrite, after);
    expect(after.get("unrelated.md")?.bytes).toBe(UNRELATED);
    expect(before.get("ref.md")?.bytes).toBe(after.get("ref.md")?.bytes);
  });

  test("real collection-lock contention returns conflict with zero mutation", async () => {
    const root = await makeRoot(tempDirs);
    await writeNote(root, "old-note.md", "# Old\n");
    await writeNote(root, "unrelated.md", UNRELATED);
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent: "# Old\n",
      referrers: [],
    });
    const lockPath = join(root, ".gno-refactor.lock");
    const held = await acquireWriteLock(lockPath, 200);
    expect(held).not.toBeNull();
    const before = await snapshotTree(root);
    try {
      const result = await applyFileRefactor(
        plan,
        {
          schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
          planDigest: plan.planDigest,
          confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        },
        depsFor(root, {
          acquireLock: acquireWriteLock,
          lockTimeoutMs: 50,
        })
      );
      expect(result.status).toBe("conflict");
      expect(result.filesystem.state).toBe("unchanged");
      assertTreeUnchanged(before, await snapshotTree(root));
    } finally {
      await held?.release();
    }
  });

  test("interrupt before commit restores every byte including unrelated", async () => {
    const root = await makeRoot(tempDirs);
    const sourceContent = "See [[Old Note#A]].\n";
    const refA = 'A [[Old Note|Alias]] and [x](old-note.md "T").\n';
    const refB = "B [[Old Note]].\n";
    await writeNote(root, "old-note.md", sourceContent);
    await writeNote(root, "a.md", refA);
    await writeNote(root, "b.md", refB);
    await writeNote(root, "unrelated.md", UNRELATED);
    const before = await snapshotTree(root);
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent,
      referrers: [
        { relPath: "a.md", content: refA },
        { relPath: "b.md", content: refB },
      ],
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
    expect(result.filesystem.state).toBe("unchanged");
    expect(result.status).not.toBe("applied");
    assertTreeUnchanged(before, await snapshotTree(root));
    expect(await listGnoRfArtifacts(root)).toEqual([]);

    const injected = await applyFileRefactor(
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
        },
      })
    );
    expect(injected.status).toBe("failed_rolled_back");
    if (injected.filesystem.state === "rolled_back") {
      assertTreeUnchanged(before, await snapshotTree(root));
      expect(await listGnoRfArtifacts(root)).toEqual([]);
    } else {
      expect(injected.filesystem.state).toBe("recovery_required");
      expect(await readNote(root, "unrelated.md")).toBe(UNRELATED);
    }
  });

  test("sync-pending is truthful and recovery mutates no files", async () => {
    const root = await makeRoot(tempDirs);
    const sourceContent = "# Old\n";
    const ref = "See [[Old Note|Alias]].\n";
    await writeNote(root, "old-note.md", sourceContent);
    await writeNote(root, "ref.md", ref);
    await writeNote(root, "unrelated.md", UNRELATED);
    const plan = await buildRenamePlan({
      sourceRel: "old-note.md",
      targetRel: "new-note.md",
      sourceContent,
      referrers: [{ relPath: "ref.md", content: ref }],
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

    const first = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      deps
    );
    expect(first.status).toBe("applied_with_sync_pending");
    expect(first.filesystem.state).toBe("committed");
    expect(first.indexConvergence.state).toBe("pending");
    expect(await exists(root, "new-note.md")).toBe(true);
    expect(await readNote(root, "ref.md")).toContain("[[New Note|Alias]]");
    expect(await readNote(root, "unrelated.md")).toBe(UNRELATED);
    const committed = await snapshotTree(root);

    const second = await applyFileRefactor(
      plan,
      {
        schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
        planDigest: plan.planDigest,
        confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
      },
      deps
    );
    expect(second.status).toBe("applied");
    expect(second.indexConvergence.state).toBe("converged");
    expect(syncCalls).toBe(2);
    assertTreeUnchanged(committed, await snapshotTree(root));
  });
});
