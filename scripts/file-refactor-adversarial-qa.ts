#!/usr/bin/env bun
/**
 * Disposable-workspace QA harness for reference-safe rename/move proofs.
 *
 * Proves preview → apply → rollback/sync-pending receipts against a temp
 * collection root. Does not mutate the repo workspace.
 *
 * Run: bun scripts/file-refactor-adversarial-qa.ts
 */

// node:fs/promises mkdir/mkdtemp — structure ops; no Bun equivalent
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os tmpdir — no Bun equivalent
import { tmpdir } from "node:os";
// node:path join — no Bun path utils
import { join } from "node:path";

import { acquireWriteLock } from "../src/core/file-lock";
import {
  applyFileRefactor,
  createMemoryFileRefactorJournal,
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_SCHEMA_VERSION,
  fingerprintUtf8Content,
  planFileRefactorImpact,
  type FileRefactorPreviewPlan,
} from "../src/core/file-refactors";
import { safeRm } from "../test/helpers/cleanup";

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const UNRELATED = "UNRELATED_SENTINEL_BYTES_ζ\n";

interface StepResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const steps: StepResult[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  steps.push({ name, ok, detail });
  console.log(
    `  ${ok ? green("PASS") : red("FAIL")} ${name}${detail ? ` — ${detail}` : ""}`
  );
}

async function writeNote(
  root: string,
  rel: string,
  content: string
): Promise<void> {
  const abs = join(root, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await Bun.write(abs, content);
}

async function readNote(root: string, rel: string): Promise<string> {
  return Bun.file(join(root, ...rel.split("/"))).text();
}

async function fingerprintTree(root: string): Promise<Map<string, string>> {
  const glob = new Bun.Glob("**/*");
  const out = new Map<string, string>();
  for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
    out.set(
      rel,
      await fingerprintUtf8Content(await Bun.file(join(root, rel)).text())
    );
  }
  return out;
}

function treesEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

async function buildPlan(root: string): Promise<{
  plan: FileRefactorPreviewPlan;
  sourceContent: string;
  refContent: string;
}> {
  const sourceContent = "Self [[Old Note#A]]\n";
  const refContent = [
    "Wiki [[Old Note|Alias]]",
    'MD [L](old-note.md "T")',
    "Angle [x](<old-note.md#frag>)",
    "Fence:\n```md\n[[Old Note]]\n```",
    "",
  ].join("\n");
  await writeNote(root, "old-note.md", sourceContent);
  await writeNote(root, "referrer.md", refContent);
  await writeNote(root, "unrelated.md", UNRELATED);
  const plan = await planFileRefactorImpact({
    operation: "rename",
    source: {
      uri: "gno://notes/old-note.md",
      relPath: "old-note.md",
      collection: "notes",
      title: "Old Note",
      content: sourceContent,
      editable: true,
    },
    target: {
      uri: "gno://notes/new-note.md",
      relPath: "new-note.md",
      collection: "notes",
      title: "New Note",
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
        uri: "gno://notes/referrer.md",
        relPath: "referrer.md",
        collection: "notes",
        title: "referrer",
        content: refContent,
      },
    ],
    targetOccupied: false,
  });
  return { plan, sourceContent, refContent };
}

function deps(root: string, overrides: Record<string, unknown> = {}) {
  return {
    collectionRoot: root,
    lockPath: join(root, ".gno-refactor.lock"),
    journal: createMemoryFileRefactorJournal(),
    syncAfterCommit: async () => undefined,
    ...overrides,
  };
}

async function main(): Promise<number> {
  console.log("file-refactor adversarial disposable-workspace QA");
  const roots: string[] = [];
  try {
    // Preview grammar
    {
      const root = await mkdtemp(join(tmpdir(), "gno-rf-qa-preview-"));
      roots.push(root);
      const { plan } = await buildPlan(root);
      const rewriteable = plan.examinedReferences.filter(
        (r) => r.classification === "rewriteable"
      );
      const opaque = plan.examinedReferences.filter(
        (r) => r.reasonCode === "code_fence_context"
      );
      record(
        "preview grammar (alias/title/angle + fence opaque)",
        plan.canApply && rewriteable.length >= 3 && opaque.length >= 1,
        `digest=${plan.planDigest.slice(0, 12)} rewriteable=${rewriteable.length}`
      );
    }

    // Happy apply + unrelated bytes
    {
      const root = await mkdtemp(join(tmpdir(), "gno-rf-qa-apply-"));
      roots.push(root);
      const { plan } = await buildPlan(root);
      const beforeUnrelated = await fingerprintUtf8Content(UNRELATED);
      const result = await applyFileRefactor(
        plan,
        {
          schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
          planDigest: plan.planDigest,
          confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        },
        deps(root)
      );
      const ref = await readNote(root, "referrer.md");
      const unrelatedOk =
        (await readNote(root, "unrelated.md")) === UNRELATED &&
        (await fingerprintUtf8Content(await readNote(root, "unrelated.md"))) ===
          beforeUnrelated;
      record(
        "apply rewrite + unrelated byte-exact",
        result.status === "applied" &&
          ref.includes("[[New Note|Alias]]") &&
          ref.includes("[x](<new-note.md#frag>)") &&
          ref.includes("```md\n[[Old Note]]\n```") &&
          unrelatedOk,
        `status=${result.status}`
      );
    }

    // Stale plan
    {
      const root = await mkdtemp(join(tmpdir(), "gno-rf-qa-stale-"));
      roots.push(root);
      const { plan } = await buildPlan(root);
      const before = await fingerprintTree(root);
      await writeNote(root, "old-note.md", "# Changed\n");
      const afterWrite = await fingerprintTree(root);
      const result = await applyFileRefactor(
        plan,
        {
          schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
          planDigest: plan.planDigest,
          confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        },
        deps(root)
      );
      const after = await fingerprintTree(root);
      record(
        "stale-plan rejection zero mutation",
        result.status === "stale_plan" && treesEqual(afterWrite, after),
        `status=${result.status} unrelated=${after.get("unrelated.md") === before.get("unrelated.md")}`
      );
    }

    // Lock contention
    {
      const root = await mkdtemp(join(tmpdir(), "gno-rf-qa-lock-"));
      roots.push(root);
      const { plan } = await buildPlan(root);
      const lockPath = join(root, ".gno-refactor.lock");
      const held = await acquireWriteLock(lockPath, 200);
      const before = await fingerprintTree(root);
      try {
        const result = await applyFileRefactor(
          plan,
          {
            schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
            planDigest: plan.planDigest,
            confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
          },
          deps(root, {
            acquireLock: acquireWriteLock,
            lockTimeoutMs: 50,
          })
        );
        const after = await fingerprintTree(root);
        record(
          "collection-lock contention",
          result.status === "conflict" && treesEqual(before, after),
          `status=${result.status}`
        );
      } finally {
        await held?.release();
      }
    }

    // Interrupt rollback
    {
      const root = await mkdtemp(join(tmpdir(), "gno-rf-qa-abort-"));
      roots.push(root);
      const { plan } = await buildPlan(root);
      const before = await fingerprintTree(root);
      const ac = new AbortController();
      const result = await applyFileRefactor(
        plan,
        {
          schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
          planDigest: plan.planDigest,
          confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        },
        deps(root, {
          onBoundary: async (b: { kind: string }) => {
            if (b.kind === "before_commit") ac.abort();
          },
        }),
        ac.signal
      );
      const after = await fingerprintTree(root);
      record(
        "interrupt before_commit byte-exact restore",
        result.filesystem.state === "unchanged" && treesEqual(before, after),
        `status=${result.status} fs=${result.filesystem.state}`
      );
    }

    // Sync-pending recovery
    {
      const root = await mkdtemp(join(tmpdir(), "gno-rf-qa-sync-"));
      roots.push(root);
      const { plan } = await buildPlan(root);
      const journal = createMemoryFileRefactorJournal();
      let syncCalls = 0;
      const shared = deps(root, {
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
        shared
      );
      const committed = await fingerprintTree(root);
      const second = await applyFileRefactor(
        plan,
        {
          schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
          planDigest: plan.planDigest,
          confirmation: FILE_REFACTOR_APPLY_CONFIRMATION,
        },
        shared
      );
      const after = await fingerprintTree(root);
      record(
        "sync-pending truthfulness + recovery",
        first.status === "applied_with_sync_pending" &&
          first.filesystem.state === "committed" &&
          second.status === "applied" &&
          syncCalls === 2 &&
          treesEqual(committed, after),
        `first=${first.status} second=${second.status} syncCalls=${syncCalls}`
      );
    }
  } finally {
    for (const root of roots) {
      await safeRm(root);
    }
  }

  const failed = steps.filter((s) => !s.ok);
  console.log(
    failed.length === 0
      ? green(`\nAll ${steps.length} QA steps passed.`)
      : red(`\n${failed.length}/${steps.length} QA steps failed.`)
  );
  return failed.length === 0 ? 0 : 1;
}

const code = await main();
process.exit(code);
