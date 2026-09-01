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

import type { ExtractedBlock } from "./block.js";
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

/**
 * Append or replace the managed block; bytes outside the block untouched.
 *
 * Append separators preserve the original trailing-newline state:
 * - empty file → block only
 * - ends with `\n` → one blank line, then the block
 * - missing final newline → a single added `\n`, then the block; the caller
 *   records that fact inside the block (stamp `+nl` token) so uninstall can
 *   restore the file byte-identically without inferring from file shape
 */
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
  const separator =
    oldContent.length === 0 || oldContent.endsWith("\n") ? "" : "\n";
  const blankLine = oldContent.endsWith("\n") ? "\n" : "";
  return `${oldContent}${separator}${blankLine}${rendered}\n`;
}

/**
 * Remove the managed block plus whatever separator install added above it —
 * the one blank line (original file ended in `\n`), or the single newline
 * install appended to a file that had no final newline. The latter is only
 * consumed when the block's stamp records it (`+nl` token): a lone newline
 * before the block is otherwise user content and must be preserved.
 */
function withoutBlock(oldContent: string, block: ExtractedBlock): string {
  let start = block.start;
  let end = block.end;
  // Consume the newline terminating the block line.
  if (oldContent[end] === "\n") {
    end += 1;
  }
  if (oldContent.slice(start - 2, start) === "\n\n") {
    // Consume the single separating blank line install added.
    start -= 1;
  } else if (
    block.stamp?.addedLeadingNewline === true &&
    end >= oldContent.length &&
    oldContent[start - 1] === "\n"
  ) {
    // The stamp records that install appended this newline to a file that
    // had no final newline — consume it to restore the original bytes. The
    // EOF guard keeps lines intact if content was later added below the
    // block (the newline then terminates the preceding line).
    start -= 1;
  }
  return oldContent.slice(0, start) + oldContent.slice(end);
}

// ─────────────────────────────────────────────────────────────────────────────
// Consumer Aggregation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Effective skill state per consumed real file: every detected harness that
 * reads a given instruction file must have the skill for the file's block to
 * carry the skill-installed pointer. One shared file can serve consumers
 * with different skill states (a symlinked `~/AGENTS.md`, an import chain),
 * and a `/gno` pointer is only followable when ALL of them have the skill —
 * otherwise the conservative `gno skill install` pointer is rendered.
 *
 * Keyed by real-file identity. A detected covered target (import chain, e.g.
 * grok → claude) consumes its covering target's file, so its skill state
 * constrains that file too. Undetected targets consume nothing — a covering
 * target planned only as a write vehicle does not constrain the render.
 */
export function aggregateSkillInstalled(
  targets: ResolvedTarget[]
): Map<string, boolean> {
  const byId = new Map(targets.map((t) => [t.id, t]));
  const skillByFile = new Map<string, boolean>();
  for (const target of targets) {
    if (!target.detected) {
      continue;
    }
    // Follow the import chain to the file this harness actually reads.
    let consumed: ResolvedTarget | undefined = target;
    const visited = new Set<string>();
    while (consumed?.coveredBy && !visited.has(consumed.id)) {
      visited.add(consumed.id);
      consumed = byId.get(consumed.coveredBy);
    }
    if (!consumed) {
      continue;
    }
    const key = consumed.realFile;
    skillByFile.set(
      key,
      (skillByFile.get(key) ?? true) && target.skillInstalled
    );
  }
  return skillByFile;
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
 *
 * `skillByFile` is the consumer aggregation used to render each file's
 * skill pointer. Callers with an explicit-target run must compute it over
 * the FULL harness matrix (every detected consumer of each real file), not
 * over the filtered `targets` — otherwise a shared file is rendered from
 * the requested targets' skill states alone. Defaults to aggregating over
 * `targets`, which is only correct when they already span the full matrix.
 */
export async function planTargets(
  targets: ResolvedTarget[],
  mode: PlanMode,
  skillByFile: Map<string, boolean> = aggregateSkillInstalled(targets)
): Promise<TargetPlan[]> {
  const plans: TargetPlan[] = [];
  /** Real-file identity → id of the target that owns the write. */
  const owners = new Map<string, string>();

  // A detected covered target (e.g. grok → claude) is only truly covered
  // when its covering target's file converges too — so the covering target
  // is planned even when its own harness is not detected on this machine.
  const requiredCovering = new Set<string>();
  for (const t of targets) {
    if (t.detected && t.coveredBy) {
      requiredCovering.add(t.coveredBy);
    }
  }

  for (const target of targets) {
    if (!(target.detected || requiredCovering.has(target.id))) {
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
      // Coverage is only reportable when the covering target is resolved in
      // this run (its own plan row carries the actual convergence).
      const coveringResolved = targets.some((t) => t.id === target.coveredBy);
      plans.push({
        target,
        action: coveringResolved ? "covered" : "error",
        ...(coveringResolved && { via: target.coveredBy }),
        detail: coveringResolved
          ? `covered via ${target.coveredBy}`
          : `covered via ${target.coveredBy}, but ${target.coveredBy} was not resolved in this run`,
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
        fileExists: await Bun.file(target.file).exists(),
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

    // Fresh install onto a file missing its final newline: withBlock will
    // append one, and the stamp records that fact for uninstall. Updates
    // carry the recorded provenance forward unchanged.
    const addedLeadingNewline = extraction.found
      ? (extraction.block.stamp?.addedLeadingNewline ?? false)
      : content.length > 0 && !content.endsWith("\n");
    const rendered = renderBlock({
      // Aggregate across every detected consumer of this real file — the
      // skill-installed pointer is rendered only when ALL of them have the
      // skill (a shared file can serve harnesses with different states).
      skillInstalled: skillByFile.get(target.realFile) ?? target.skillInstalled,
      addedLeadingNewline,
    });
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
      await Bun.write(backupPath, Bun.file(writePath));
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
