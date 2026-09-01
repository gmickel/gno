/**
 * Plan/apply engine for `gno agents` — marker-managed block installation.
 *
 * Guarantees:
 * - Only the owned block changes; content outside markers is byte-identical.
 * - Backup-first: the touched file is backed up before any write.
 * - Idempotent: re-running when current is a no-op (no write, no backup).
 * - Symlink-aware: writes go through the resolved real file; targets that
 *   resolve to the same real file are written once.
 *
 * @module src/cli/commands/agents/engine
 */

import { existsSync } from "node:fs";
// node:fs realpath/lstat are needed for symlink-aware write identity;
// copyFile for content backups. No Bun equivalents.
import { copyFile } from "node:fs/promises";

import type { ResolvedTarget } from "./harnesses.js";

import { CliError } from "../../errors.js";
import { extractBlock, renderBlock } from "./block.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PlanAction =
  | "install" // no block yet — append it
  | "update" // block present but differs — replace in place
  | "current" // block present and identical — no-op
  | "remove" // uninstall: block present — remove it
  | "absent" // uninstall: no block — no-op
  | "covered" // import chain or same real file — another target owns it
  | "not-detected" // harness not installed on this machine — skipped
  | "error"; // fail-closed (malformed markers, unreadable file)

export interface TargetPlan {
  target: ResolvedTarget;
  action: PlanAction;
  /** Target id that covers this one (import chain or shared real file). */
  via?: string;
  /** Human-readable detail (e.g. error guidance). */
  detail?: string;
  /** Existing file content ("" when the file does not exist yet). */
  oldContent: string;
  /** Content after the change (equal to oldContent for no-op actions). */
  newContent: string;
  fileExists: boolean;
}

export type PlanMode = "install" | "uninstall";

// ─────────────────────────────────────────────────────────────────────────────
// Content Transforms
// ─────────────────────────────────────────────────────────────────────────────

function ensureTrailingNewline(content: string): string {
  return content.length === 0 || content.endsWith("\n")
    ? content
    : `${content}\n`;
}

/** Append or replace the managed block; bytes outside the block untouched. */
function withBlock(
  oldContent: string,
  block: { start: number; end: number } | null,
  rendered: string
): string {
  if (block) {
    return (
      oldContent.slice(0, block.start) + rendered + oldContent.slice(block.end)
    );
  }
  const base = ensureTrailingNewline(oldContent);
  const separator = base.length === 0 ? "" : "\n";
  return `${base}${separator}${rendered}\n`;
}

/** Remove the managed block plus the one blank line install added above it. */
function withoutBlock(
  oldContent: string,
  block: { start: number; end: number }
): string {
  let start = block.start;
  let end = block.end;
  // Consume the newline terminating the block line.
  if (oldContent[end] === "\n") {
    end += 1;
  }
  // Consume the single separating blank line install added, when present.
  if (oldContent.slice(start - 2, start) === "\n\n") {
    start -= 1;
  }
  return oldContent.slice(0, start) + oldContent.slice(end);
}

// ─────────────────────────────────────────────────────────────────────────────
// Planning
// ─────────────────────────────────────────────────────────────────────────────

async function readFileIfExists(
  path: string
): Promise<{ exists: boolean; content: string }> {
  const file = Bun.file(path);
  if (await file.exists()) {
    return { exists: true, content: await file.text() };
  }
  return { exists: false, content: "" };
}

/**
 * Build a per-target plan. Fail-closed per file: a target with malformed
 * markers gets an `error` plan (and never a write); other targets proceed.
 */
export async function planTargets(
  targets: ResolvedTarget[],
  mode: PlanMode
): Promise<TargetPlan[]> {
  const plans: TargetPlan[] = [];
  /** Real-file identity → id of the target that owns the write. */
  const owners = new Map<string, string>();

  for (const target of targets) {
    if (!target.detected) {
      plans.push({
        target,
        action: "not-detected",
        oldContent: "",
        newContent: "",
        fileExists: false,
      });
      continue;
    }

    if (target.coveredBy) {
      plans.push({
        target,
        action: "covered",
        via: target.coveredBy,
        detail: `covered via ${target.coveredBy}`,
        oldContent: "",
        newContent: "",
        fileExists: false,
      });
      continue;
    }

    const owner = owners.get(target.realFile);
    if (owner) {
      plans.push({
        target,
        action: "covered",
        via: owner,
        detail: `covered via ${owner} (same file)`,
        oldContent: "",
        newContent: "",
        fileExists: existsSync(target.file),
      });
      continue;
    }
    owners.set(target.realFile, target.id);

    let exists = false;
    let content = "";
    try {
      ({ exists, content } = await readFileIfExists(target.file));
    } catch (err) {
      plans.push({
        target,
        action: "error",
        detail: `cannot read ${target.file}: ${err instanceof Error ? err.message : String(err)}`,
        oldContent: "",
        newContent: "",
        fileExists: false,
      });
      continue;
    }

    let extraction: ReturnType<typeof extractBlock>;
    try {
      extraction = extractBlock(content, target.file);
    } catch (err) {
      plans.push({
        target,
        action: "error",
        detail: err instanceof Error ? err.message : String(err),
        oldContent: content,
        newContent: content,
        fileExists: exists,
      });
      continue;
    }

    if (mode === "uninstall") {
      if (!extraction.found) {
        plans.push({
          target,
          action: "absent",
          oldContent: content,
          newContent: content,
          fileExists: exists,
        });
        continue;
      }
      plans.push({
        target,
        action: "remove",
        oldContent: content,
        newContent: withoutBlock(content, extraction.block),
        fileExists: exists,
      });
      continue;
    }

    const rendered = renderBlock({ skillInstalled: target.skillInstalled });
    const newContent = withBlock(
      content,
      extraction.found ? extraction.block : null,
      rendered
    );

    plans.push({
      target,
      action: !extraction.found
        ? "install"
        : newContent === content
          ? "current"
          : "update",
      oldContent: content,
      newContent,
      fileExists: exists,
    });
  }

  return plans;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply
// ─────────────────────────────────────────────────────────────────────────────

const WRITE_ACTIONS: PlanAction[] = ["install", "update", "remove"];

export function planWrites(plan: TargetPlan): boolean {
  return WRITE_ACTIONS.includes(plan.action);
}

/**
 * Apply one plan: backup the touched file, then write through the resolved
 * real file so operator symlink schemes stay intact.
 * Returns the backup path (null when the file did not exist).
 */
export async function applyPlan(plan: TargetPlan): Promise<string | null> {
  if (!planWrites(plan)) {
    return null;
  }

  // Write through symlinks: the resolved identity is the real file.
  const writePath = plan.fileExists ? plan.target.realFile : plan.target.file;

  let backupPath: string | null = null;
  if (plan.fileExists) {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace(/Z$/, "");
    backupPath = `${writePath}.gno-agents.bak.${timestamp}`;
    try {
      await copyFile(writePath, backupPath);
    } catch (err) {
      throw new CliError(
        "RUNTIME",
        `Backup failed for ${writePath}: ${err instanceof Error ? err.message : String(err)} — nothing was written.`
      );
    }
  }

  try {
    await Bun.write(writePath, plan.newContent);
  } catch (err) {
    throw new CliError(
      "RUNTIME",
      `Write failed for ${writePath}: ${err instanceof Error ? err.message : String(err)}` +
        (backupPath ? ` (backup preserved at ${backupPath})` : "")
    );
  }

  return backupPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Diff (dry-run)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal unified diff. Block install/update/remove is a single contiguous
 * change, so common prefix/suffix with one hunk is exact.
 */
export function unifiedDiff(
  oldContent: string,
  newContent: string,
  path: string
): string {
  if (oldContent === newContent) {
    return "";
  }

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);

  const CONTEXT = 3;
  const ctxBefore = oldLines.slice(Math.max(0, prefix - CONTEXT), prefix);
  const ctxAfterStart = oldLines.length - suffix;
  const ctxAfter = oldLines.slice(ctxAfterStart, ctxAfterStart + CONTEXT);

  const oldStart = Math.max(1, prefix - CONTEXT + 1);
  const newStart = oldStart;
  const oldCount = ctxBefore.length + oldChanged.length + ctxAfter.length;
  const newCount = ctxBefore.length + newChanged.length + ctxAfter.length;

  const lines: string[] = [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
  ];
  for (const line of ctxBefore) {
    lines.push(` ${line}`);
  }
  for (const line of oldChanged) {
    lines.push(`-${line}`);
  }
  for (const line of newChanged) {
    lines.push(`+${line}`);
  }
  for (const line of ctxAfter) {
    lines.push(` ${line}`);
  }
  return lines.join("\n");
}
