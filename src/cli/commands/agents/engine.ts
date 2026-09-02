/**
 * Plan/apply engine for `gno agents` — marker-managed block installation.
 *
 * Guarantees:
 * - Only the owned block changes; content outside markers is byte-identical.
 * - Backup-first: an existing file is copied to `<file>.gno-agents.bak.<ts>`
 *   before any write; the write itself lands via a sibling temp file and an
 *   atomic rename, so a failed write leaves the live file untouched.
 * - Idempotent: re-running when current is a no-op (no write, no backup).
 * - Symlink-aware: writes go through the resolved real file; targets that
 *   resolve to the same real file are written once.
 * - Fail-closed: malformed markers, non-UTF-8 content, or any I/O failure
 *   produce an `error` row and no write — the command then prints the block
 *   so the operator can apply it by hand.
 *
 * @module src/cli/commands/agents/engine
 */

// node:fs/promises: Bun has no chmod (the backup and the replacement must
// keep the source file's mode), no atomic rename, and no unlink.
import { chmod, rename, stat, unlink } from "node:fs/promises";

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

export type PlanMode = "install" | "uninstall";

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
  /** The existing file began with a UTF-8 BOM; the write re-prepends it. */
  bom?: boolean;
  /**
   * For `action: "error"`: exit-code category — VALIDATION for bad content
   * (malformed markers, non-UTF-8), RUNTIME for filesystem failures.
   */
  errorCode?: "VALIDATION" | "RUNTIME";
}

const UTF8_BOM = "﻿";
const utf8Fatal = new TextDecoder("utf-8", { fatal: true });

/**
 * Decode an instruction file's bytes without normalizing operator content:
 * a UTF-8 BOM is split off (and reported) rather than dropped, and any
 * non-UTF-8 sequence is a hard error rather than a silent replacement
 * character — rewriting such a file would corrupt bytes outside the markers.
 */
export function decodeInstructionFile(
  bytes: Uint8Array,
  path: string
): { content: string; bom: boolean } {
  const bom =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  try {
    return { content: utf8Fatal.decode(body), bom };
  } catch {
    throw new CliError(
      "VALIDATION",
      `${path} is not valid UTF-8; refusing to rewrite it (bytes outside the GNO agents block would be altered). Convert the file to UTF-8, then re-run.`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Content Transforms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append or replace the managed block; bytes outside the block untouched.
 * A fresh install goes at the end of the file, separated by one blank line
 * (a file without a final newline gets that newline first).
 */
export function withBlock(
  oldContent: string,
  block: ExtractedBlock | null,
  rendered: string
): string {
  if (block) {
    return (
      oldContent.slice(0, block.start) + rendered + oldContent.slice(block.end)
    );
  }
  if (oldContent.length === 0) {
    return `${rendered}\n`;
  }
  const terminator = oldContent.endsWith("\n") ? "" : "\n";
  return `${oldContent}${terminator}\n${rendered}\n`;
}

/**
 * Remove the managed block plus the newline that terminates it and the blank
 * line install put above it (when one is there). Operator content is never
 * touched beyond that single separator.
 */
export function withoutBlock(
  oldContent: string,
  block: ExtractedBlock
): string {
  let start = block.start;
  let end = block.end;
  if (oldContent[end] === "\n") {
    end += 1;
  }
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
): Promise<{ exists: boolean; content: string; bom: boolean }> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { exists: false, content: "", bom: false };
  }
  // Bytes, not .text(): text() strips a BOM and replaces invalid sequences,
  // which would silently alter operator-owned bytes on the rewrite.
  const { content, bom } = decodeInstructionFile(await file.bytes(), path);
  return { exists: true, content, bom };
}

function noopPlan(
  target: ResolvedTarget,
  action: PlanAction,
  extra: Partial<TargetPlan> = {}
): TargetPlan {
  return {
    target,
    action,
    oldContent: "",
    newContent: "",
    fileExists: false,
    ...extra,
  };
}

/**
 * Build a per-target plan. Fail-closed per file: a target with malformed
 * markers or an unreadable file gets an `error` plan (and never a write);
 * other targets proceed.
 */
export async function planTargets(
  targets: ResolvedTarget[],
  mode: PlanMode
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
      plans.push(noopPlan(target, "not-detected"));
      continue;
    }
    if (target.coveredBy) {
      const coveringResolved = targets.some((t) => t.id === target.coveredBy);
      plans.push(
        coveringResolved
          ? noopPlan(target, "covered", {
              via: target.coveredBy,
              detail: `covered via ${target.coveredBy}`,
            })
          : noopPlan(target, "error", {
              errorCode: "VALIDATION",
              detail: `covered via ${target.coveredBy}, but ${target.coveredBy} was not resolved in this run`,
            })
      );
      continue;
    }
    const owner = owners.get(target.realFile);
    if (owner) {
      plans.push(
        noopPlan(target, "covered", {
          via: owner,
          detail: `covered via ${owner} (same file)`,
        })
      );
      continue;
    }
    owners.set(target.realFile, target.id);

    let exists = false;
    let content = "";
    let bom = false;
    let extraction: ReturnType<typeof extractBlock>;
    try {
      ({ exists, content, bom } = await readFileIfExists(target.file));
      extraction = extractBlock(content, target.file);
    } catch (err) {
      plans.push(
        noopPlan(target, "error", {
          errorCode:
            err instanceof CliError && err.code === "VALIDATION"
              ? "VALIDATION"
              : "RUNTIME",
          detail: err instanceof Error ? err.message : String(err),
          oldContent: content,
          newContent: content,
          fileExists: exists,
        })
      );
      continue;
    }

    const base = { target, oldContent: content, fileExists: exists, bom };
    if (mode === "uninstall") {
      plans.push(
        extraction.found
          ? {
              ...base,
              action: "remove",
              newContent: withoutBlock(content, extraction.block),
            }
          : { ...base, action: "absent", newContent: content }
      );
      continue;
    }

    const newContent = withBlock(
      content,
      extraction.found ? extraction.block : null,
      renderBlock()
    );
    plans.push({
      ...base,
      action: !extraction.found
        ? "install"
        : newContent === content
          ? "current"
          : "update",
      newContent,
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Apply one plan: back up an existing file, then write the new content via a
 * sibling temp file + atomic rename, through the resolved real file so
 * operator symlink schemes stay intact. Returns the backup path (null when
 * the file did not exist). Any failure throws RUNTIME with the live file
 * unchanged (a backup already made is reported, not removed).
 */
export async function applyPlan(plan: TargetPlan): Promise<string | null> {
  if (!planWrites(plan)) {
    return null;
  }
  const writePath = plan.target.realFile;
  const bytes = (plan.bom ? UTF8_BOM : "") + plan.newContent;

  if (!plan.fileExists) {
    try {
      await Bun.write(writePath, bytes);
    } catch (err) {
      throw new CliError(
        "RUNTIME",
        `Write failed for ${writePath}: ${describe(err)}`
      );
    }
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${writePath}.gno-agents.bak.${timestamp}`;
  const tempPath = `${writePath}.gno-agents.tmp`;
  try {
    // Keep the source mode on both copies: a 0600 instruction file must not
    // gain a world-readable backup or replacement.
    const mode = (await stat(writePath)).mode & 0o777;
    await Bun.write(backupPath, Bun.file(writePath));
    await chmod(backupPath, mode);
    await Bun.write(tempPath, bytes);
    await chmod(tempPath, mode);
    await rename(tempPath, writePath);
  } catch (err) {
    // Best-effort: never accumulate temp files across repeated failures.
    await unlink(tempPath).catch(() => {});
    throw new CliError(
      "RUNTIME",
      `Write failed for ${writePath}: ${describe(err)}; the live file is unchanged`
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
