/**
 * Shared fixtures for file-refactor apply service tests.
 *
 * @module test/core/file-refactor-service-helpers
 */

// node:fs/promises for mkdtemp/mkdir (structure ops; no Bun equivalent)
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os tmpdir — no Bun equivalent
import { tmpdir } from "node:os";
// node:path join — no Bun equivalent
import { join } from "node:path";

import type { WriteLockHandle } from "../../src/core/file-lock";

import {
  createMemoryFileRefactorJournal,
  planFileRefactorImpact,
  type ApplyFileRefactorDeps,
  type FileRefactorPreviewPlan,
} from "../../src/core/file-refactors";
import { safeRm } from "../helpers/cleanup";

export async function cleanupTempDirs(tempDirs: string[]): Promise<void> {
  for (const path of tempDirs.splice(0)) {
    await safeRm(path);
  }
}

export async function makeRoot(tempDirs: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gno-rf-svc-"));
  tempDirs.push(root);
  return root;
}

export async function writeNote(
  root: string,
  relPath: string,
  content: string
) {
  const abs = join(root, ...relPath.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await Bun.write(abs, content);
  return abs;
}

export async function readNote(root: string, relPath: string): Promise<string> {
  return Bun.file(join(root, ...relPath.split("/"))).text();
}

export async function exists(root: string, relPath: string): Promise<boolean> {
  return Bun.file(join(root, ...relPath.split("/"))).exists();
}

/** List leftover `.gno-rf-*` sibling artifacts under the collection root. */
export async function listGnoRfArtifacts(root: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.gno-rf-*");
  const matches: string[] = [];
  for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
    matches.push(path);
  }
  return matches.sort();
}

export function lockOk(): WriteLockHandle {
  return { release: async () => undefined };
}

export async function buildRenamePlan(input: {
  sourceRel: string;
  targetRel: string;
  sourceContent: string;
  referrers: Array<{ relPath: string; content: string }>;
}): Promise<FileRefactorPreviewPlan> {
  const documents = [
    {
      id: 1,
      uri: `gno://notes/${input.sourceRel}`,
      relPath: input.sourceRel,
      collection: "notes",
      title: "Old Note",
      content: input.sourceContent,
    },
    ...input.referrers.map((ref, index) => ({
      id: index + 2,
      uri: `gno://notes/${ref.relPath}`,
      relPath: ref.relPath,
      collection: "notes",
      title: ref.relPath.replace(/\.md$/, ""),
      content: ref.content,
    })),
  ];

  return planFileRefactorImpact({
    operation: "rename",
    source: {
      uri: `gno://notes/${input.sourceRel}`,
      relPath: input.sourceRel,
      collection: "notes",
      title: "Old Note",
      content: input.sourceContent,
      editable: true,
    },
    target: {
      uri: `gno://notes/${input.targetRel}`,
      relPath: input.targetRel,
      collection: "notes",
      title: "New Note",
    },
    documents,
    targetOccupied: false,
  });
}

export function depsFor(
  root: string,
  overrides: Partial<ApplyFileRefactorDeps> = {}
): ApplyFileRefactorDeps {
  return {
    collectionRoot: root,
    lockPath: join(root, ".gno-refactor.lock"),
    journal: createMemoryFileRefactorJournal(),
    syncAfterCommit: async () => undefined,
    acquireLock: async () => lockOk(),
    ...overrides,
  };
}
