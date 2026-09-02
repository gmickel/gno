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

// node:fs/promises: Bun has no API to read or set a file's permission mode;
// the backup must inherit the source file's (possibly restrictive) mode.
// mkdir: directory creation for a dangling link's resolved parent.
// rename: atomic replace of the live instruction file (Bun.write is in-place).
// open: Bun.write cannot create exclusively (O_EXCL) without following a
// pre-planted symlink, nor set ownership on the resulting inode.
import { chmod, mkdir, open, rename, stat, unlink } from "node:fs/promises";
// node:path: no Bun path utilities.
import { dirname } from "node:path";

import type {
  ExtractedBlock,
  SeparatorProvenance,
  SkillRemediation,
} from "./block.js";
import type { ResolvedTarget } from "./harnesses.js";

import { CliError } from "../../errors.js";
import {
  extractBlock,
  renderBlock,
  separatorContextHash,
  stampAuthenticates,
} from "./block.js";
import { realIdentity } from "./harnesses.js";

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
  /**
   * Real identity of `target.configDir` at plan time (`null` = absent, as for
   * an undetected covering target); revalidated before a planned-new file is
   * written so a config dir removed/moved after planning is not recreated.
   */
  configDirIdentity?: string | null;
  /**
   * Same for the parent of `target.realFile` (differs from the config dir
   * when a dangling link points outside it): a resolved parent tree removed
   * after planning is not recreated; absent-at-plan is created (dangling-link
   * install).
   */
  writeParentIdentity?: string | null;
  /**
   * The existing file began with a UTF-8 BOM. Content strings exclude it;
   * the write path re-prepends it so operator bytes outside the markers stay
   * byte-identical.
   */
  bom?: boolean;
  /**
   * For `action: "error"`: the failure category (exit-code contract — 1 for
   * invalid input such as malformed markers or non-UTF-8 content, 2 for
   * filesystem failures such as an unreadable file).
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

export type PlanMode = "install" | "uninstall";

// ─────────────────────────────────────────────────────────────────────────────
// Content Transforms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append or replace the managed block; bytes outside the block untouched.
 *
 * Append separators preserve the original trailing-newline state:
 * - empty file → block only
 * - ends with `\n` → one blank line, then the block (`sep:blank`)
 * - missing final newline → a single added `\n`, then the block (`sep:nl`)
 * The caller records which separator it added — plus a hash of the operator
 * bytes right before it — inside the block (stamp `sep:<kind> pre:<hash>`),
 * so uninstall can restore the file byte-identically without inferring from
 * file shape, and never consumes whitespace it cannot prove it added.
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
 * The separator install added above a block, when the block's stamp proves it:
 * the claim must authenticate (body + token hash) AND the recorded context
 * hash must still match the operator bytes immediately preceding the
 * separator. A block pasted/moved after existing whitespace carries a stamp
 * whose context no longer matches; a hand-edited token fails the hash. Either
 * way the answer is `undefined` — whitespace outside the markers is then
 * treated as operator content.
 */
function provenSeparator(
  content: string,
  block: ExtractedBlock
): SeparatorProvenance | undefined {
  const separator = block.stamp?.separator;
  if (!separator || !stampAuthenticates(block)) {
    return undefined;
  }
  if (separator.kind === "none") {
    // Installed into an empty file: the block must still start the file.
    return block.start === 0 && separatorContextHash("") === separator.pre
      ? separator
      : undefined;
  }
  // `blank` and `nl` occupy exactly one `\n` right before the block; the
  // operator content precedes that byte.
  if (block.start < 1 || content[block.start - 1] !== "\n") {
    return undefined;
  }
  const preceding = content.slice(0, block.start - 1);
  if (separator.kind === "blank" && !preceding.endsWith("\n")) {
    return undefined; // a blank line needs the operator's own `\n` before it
  }
  return separatorContextHash(preceding) === separator.pre
    ? separator
    : undefined;
}

/**
 * Remove the managed block plus the separator install added above it — but
 * ONLY when the block's authenticated, context-matched provenance says install
 * added it (`provenSeparator`). Whitespace without proven provenance is
 * operator content and is left intact.
 */
function withoutBlock(oldContent: string, block: ExtractedBlock): string {
  let start = block.start;
  let end = block.end;
  const separator = provenSeparator(oldContent, block);
  // Install writes exactly one `\n` after the END marker. Consume it only when
  // provenance proves this block was installed here — for a pasted or moved
  // block that byte may be the operator's (`abc<block>\nxyz` must keep its
  // line break), so without proof it stays.
  if (separator && oldContent[end] === "\n") {
    end += 1;
  }
  if (separator?.kind === "blank") {
    // Install added one blank line after the operator's `\n`-terminated file.
    start -= 1;
  } else if (separator?.kind === "nl" && end >= oldContent.length) {
    // Install appended this newline to a file that had no final newline —
    // consume it to restore the original bytes. The EOF guard keeps lines
    // intact if content was later added below the block (the newline then
    // terminates the preceding line).
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

/** The file a detected consumer actually reads (import chain followed). */
function consumedFile(
  target: ResolvedTarget,
  byId: Map<string, ResolvedTarget>
): ResolvedTarget | undefined {
  let consumed: ResolvedTarget | undefined = target;
  const visited = new Set<string>();
  while (consumed?.coveredBy && !visited.has(consumed.id)) {
    visited.add(consumed.id);
    consumed = byId.get(consumed.coveredBy);
  }
  return consumed;
}

/**
 * Per consumed real file, the consumers that still LACK the skill — what the
 * conservative pointer's remediation must install for. Scoped to actual
 * consumers so following it never creates skill/config dirs for harnesses
 * the operator never installed (which a later `agents update` would then
 * detect and write instruction files into). Same keying and chain-following
 * as `aggregateSkillInstalled`.
 */
export function aggregateRemediation(
  targets: ResolvedTarget[]
): Map<string, SkillRemediation> {
  const byId = new Map(targets.map((t) => [t.id, t]));
  // Group the lacking consumers per real file first: the remediation set is
  // computed per file so consumers with ALTERNATIVES (Cursor loads claude OR
  // codex) can be satisfied by a target another consumer already forces,
  // instead of adding their preferred target on top — an unnecessary install
  // would create a harness dir the operator never had, which a later
  // all-target `agents update` would then detect and write into.
  const lackingByFile = new Map<string, ResolvedTarget[]>();
  for (const target of targets) {
    if (!target.detected || target.skillInstalled) {
      continue;
    }
    const consumed = consumedFile(target, byId);
    if (!consumed) {
      continue;
    }
    const list = lackingByFile.get(consumed.realFile) ?? [];
    list.push(target);
    lackingByFile.set(consumed.realFile, list);
  }

  const byFile = new Map<string, SkillRemediation>();
  for (const [realFile, consumers] of lackingByFile) {
    const entry: SkillRemediation = { targets: [], extraDirs: [] };
    const flexible: ResolvedTarget[] = [];
    // Pass 1 — consumers with exactly one way to get the skill. Anything with
    // alternatives (regardless of a redirect-decoupled skillHome) waits for
    // pass 2, so a target another consumer forces can satisfy it first.
    for (const consumer of consumers) {
      if (consumer.skillTargets.length > 1) {
        flexible.push(consumer);
      } else if (consumer.id === "extra-dir") {
        entry.extraDirs.push(consumer.configDir);
      } else if (consumer.skillHome !== undefined) {
        // Decoupled from its skill target's active redirect (e.g. Grok while
        // CLAUDE_CONFIG_DIR is set): needs the skill at the STANDARD location —
        // `--target claude` would install into the redirected instance it
        // cannot load from.
        if (!entry.extraDirs.includes(consumer.skillHome)) {
          entry.extraDirs.push(consumer.skillHome);
        }
      } else if (!entry.targets.includes(consumer.skillTarget)) {
        entry.targets.push(consumer.skillTarget);
      }
    }
    // Pass 2 — consumers with alternatives add a remediation only when
    // something already selected for this file puts the skill where they LOAD
    // it from: a selected target satisfies them only when no env redirect
    // decouples them from it (`--target claude` under CLAUDE_CONFIG_DIR installs
    // into the redirected instance, while Cursor keeps reading
    // `~/.claude/skills`); a selected standard dir satisfies them when it is
    // the one they load from. Otherwise: the standard dir when redirected from
    // their preferred target, else that target.
    for (const consumer of flexible) {
      const redirected = consumer.redirectedSkillTargets ?? [];
      const satisfied =
        consumer.skillTargets.some(
          (t) => entry.targets.includes(t) && !redirected.includes(t)
        ) ||
        (consumer.skillHome !== undefined &&
          entry.extraDirs.includes(consumer.skillHome));
      if (satisfied) {
        continue;
      }
      if (consumer.skillHome !== undefined) {
        if (!entry.extraDirs.includes(consumer.skillHome)) {
          entry.extraDirs.push(consumer.skillHome);
        }
      } else if (!entry.targets.includes(consumer.skillTarget)) {
        entry.targets.push(consumer.skillTarget);
      }
    }
    byFile.set(realFile, entry);
  }
  return byFile;
}

// ─────────────────────────────────────────────────────────────────────────────
// Planning
// ─────────────────────────────────────────────────────────────────────────────

async function readFileIfExists(
  path: string
): Promise<{ exists: boolean; content: string; bom: boolean }> {
  const file = Bun.file(path);
  if (await file.exists()) {
    // Bytes, not .text(): text() strips a BOM and replaces invalid sequences,
    // which would silently alter operator-owned bytes on the rewrite.
    const { content, bom } = decodeInstructionFile(await file.bytes(), path);
    return { exists: true, content, bom };
  }
  return { exists: false, content: "", bom: false };
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
  skillByFile: Map<string, boolean> = aggregateSkillInstalled(targets),
  remediationByFile: Map<string, SkillRemediation> = aggregateRemediation(
    targets
  )
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
    let bom = false;
    try {
      ({ exists, content, bom } = await readFileIfExists(target.file));
    } catch (err) {
      plans.push({
        target,
        action: "error",
        // Non-UTF-8 content is a VALIDATION refusal; anything else here is a
        // filesystem failure (permissions, I/O) — a RUNTIME category.
        errorCode:
          err instanceof CliError && err.code === "VALIDATION"
            ? "VALIDATION"
            : "RUNTIME",
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
        bom,
      });
      continue;
    }

    // Fresh install: withBlock adds one separator above the block (a blank
    // line after a `\n`-terminated file, or the single `\n` a file without a
    // final newline lacked); record which, plus the context it was added in,
    // so uninstall can restore the original bytes. Updates carry provenance
    // forward only when it still PROVES (authenticated stamp + matching
    // context); anything else is dropped — the conservative direction, which
    // can leave an install-added separator behind but never removes operator
    // bytes on a forged or displaced claim.
    let separator: SeparatorProvenance | undefined;
    if (extraction.found) {
      separator = provenSeparator(content, extraction.block);
    } else {
      separator = {
        kind:
          content.length === 0
            ? "none"
            : content.endsWith("\n")
              ? "blank"
              : "nl",
        pre: separatorContextHash(content),
      };
    }
    const rendered = renderBlock({
      // Aggregate across every detected consumer of this real file — the
      // skill-installed pointer is rendered only when ALL of them have the
      // skill (a shared file can serve harnesses with different states).
      skillInstalled: skillByFile.get(target.realFile) ?? target.skillInstalled,
      separator,
      remediation: remediationByFile.get(target.realFile),
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
      configDirIdentity: await directoryIdentity(target.configDir),
      writeParentIdentity: await directoryIdentity(dirname(target.realFile)),
      bom,
    });
  }

  return plans;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply
// ─────────────────────────────────────────────────────────────────────────────

const WRITE_ACTIONS: PlanAction[] = ["install", "update", "remove"];

/**
 * Real identity of a config directory, or `null` when it is absent (or not a
 * directory). Recorded at plan time and compared before a planned-new write.
 */
export async function directoryIdentity(dir: string): Promise<string | null> {
  const isDir = await stat(dir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  return isDir ? realIdentity(dir) : null;
}

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

  // Write through symlinks: the resolved identity is the real file. This holds
  // for a dangling link too — its target (and, below, the target's parent) is
  // created while the link itself is preserved. Opening the lexical link would
  // fail with ENOENT when the target's parent is missing.
  const writePath = plan.target.realFile;

  // `plan.newContent` was derived from the bytes read at plan time. If an
  // editor, a dotfile sync, or another `gno agents` process changes the file
  // in the meantime, writing would silently overwrite the newer operator
  // content — so the file is re-read and compared against the planned bytes
  // TWICE: once before any side effect, and again as the very last await
  // before the atomic rename (the backup copy / stat / chmod and the temp-file
  // preparation awaits sit in between and are themselves a window). rename(2)
  // has no CAS, so this leaves exactly one read→rename hop unguarded — the
  // minimum.
  // `phase: "final"` runs after the temp file (and, for a planned-new file,
  // its parent directories) was created: a directory planned as ABSENT has
  // legitimately appeared by then, so only directories that existed at plan
  // time are still compared.
  const assertUnchanged = async (phase: "initial" | "final"): Promise<void> => {
    const dirUnchanged = async (
      dir: string,
      planned: string | null | undefined
    ): Promise<boolean> => {
      if (planned === undefined || (phase === "final" && planned === null)) {
        return true;
      }
      return (await directoryIdentity(dir)) === planned;
    };
    // The plan resolved `target.file` to `realFile` (symlinks followed). If
    // the operator retargeted the link in the meantime, the harness now reads
    // a different file — writing the cached destination would modify (and
    // back up) a file nobody reads while reporting success.
    if (realIdentity(plan.target.file) !== plan.target.realFile) {
      throw new CliError(
        "RUNTIME",
        `${plan.target.file} no longer resolves to ${plan.target.realFile} (symlink retargeted after planning) — nothing was written. Re-run to plan against the current file.`
      );
    }
    // A file planned as absent is only legitimate while the harness config
    // directory it was planned under still exists and is the same directory.
    // `Bun.write` recreates missing parents, so without this check a config
    // dir deleted or moved after planning would be silently fabricated (the
    // leaf check below sees absent === absent).
    // A config dir that was ABSENT at plan time (an undetected covering target
    // promoted by a detected importer) is legitimately created, so the rule
    // is "same state as planned", not "must exist".
    if (
      !plan.fileExists &&
      !(await dirUnchanged(plan.target.configDir, plan.configDirIdentity))
    ) {
      throw new CliError(
        "RUNTIME",
        `${plan.target.configDir} disappeared or moved after ${writePath} was planned — nothing was written. Re-run to plan against the current state.`
      );
    }
    // Same rule for the RESOLVED destination's parent: a dangling link may
    // point outside the config dir, and that external tree existing at plan
    // time but removed before apply must not be recreated by the mkdir below.
    // (Absent at plan time → still absent is the supported dangling-link
    // install and is created.)
    const writeParent = dirname(writePath);
    if (
      !plan.fileExists &&
      writeParent !== plan.target.configDir &&
      !(await dirUnchanged(writeParent, plan.writeParentIdentity))
    ) {
      throw new CliError(
        "RUNTIME",
        `${writeParent} disappeared or moved after ${writePath} was planned — nothing was written. Re-run to plan against the current state.`
      );
    }
    const currentFile = Bun.file(writePath);
    const existsNow = await currentFile.exists();
    if (existsNow !== plan.fileExists) {
      throw new CliError(
        "RUNTIME",
        `${writePath} ${existsNow ? "appeared" : "disappeared"} after it was planned — nothing was written. Re-run to plan against the current file.`
      );
    }
    if (!existsNow) {
      return;
    }
    const current = decodeInstructionFile(await currentFile.bytes(), writePath);
    if (
      current.content !== plan.oldContent ||
      current.bom !== (plan.bom ?? false)
    ) {
      throw new CliError(
        "RUNTIME",
        `${writePath} changed after it was planned (concurrent edit?) — nothing was written. Re-run to plan against the current file.`
      );
    }
  };
  await assertUnchanged("initial");

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
      // A copy that failed midway (disk full, quota) may have left a partial,
      // umask-mode file holding private instruction bytes — remove it.
      await unlink(backupPath).catch(() => {});
      throw new CliError(
        "RUNTIME",
        `Backup failed for ${writePath}: ${err instanceof Error ? err.message : String(err)} — nothing was written.`
      );
    }
    try {
      // Bun.write creates the backup with the process umask; a 0600 source
      // would yield a world-readable 0644 copy of private instructions.
      // Inherit the source mode so the backup is exactly as private.
      const { mode } = await stat(writePath);
      await chmod(backupPath, mode & 0o777);
    } catch (err) {
      // Never leave a copy behind that is less private than its source: the
      // umask-mode backup already exists, so remove it before failing.
      await unlink(backupPath).catch(() => {});
      throw new CliError(
        "RUNTIME",
        `Backup failed for ${writePath}: could not apply the source file's permissions to the backup (${err instanceof Error ? err.message : String(err)}); the backup was removed and nothing was written.`
      );
    }
  }

  // Atomic replace: write a sibling temp file and rename it over the
  // destination. Writing the live file in place could truncate it or leave
  // partial bytes when the write fails midway (quota, I/O error) — the harness
  // would then read a corrupted file until the backup is restored by hand.
  // rename(2) is atomic on the same filesystem, which a sibling guarantees.
  // Random, not PID-based: in a directory another principal can write to
  // (shared --extra-dir, privileged invocation) a predictable name can be
  // pre-created as a symlink, which a following open would write through and
  // the rename would then install as the live file.
  const tempPath = `${writePath}.gno-agents.tmp.${crypto.randomUUID()}`;
  // Nothing has touched the live file yet at any failure below: remove the
  // temp file and the backup (it holds only pre-change bytes) before failing.
  const abandon = async (): Promise<void> => {
    await unlink(tempPath).catch(() => {});
    if (backupPath) {
      await unlink(backupPath).catch(() => {});
    }
  };
  try {
    if (!plan.fileExists) {
      // Dangling-link install: the resolved target's parent may not exist yet
      // (the config dir and that parent were revalidated above).
      await mkdir(dirname(writePath), { recursive: true });
    }
    // "wx" = O_CREAT|O_EXCL: fails if ANY entry — including a planted symlink,
    // dangling or not — already exists at the path, so the write never follows
    // a link. Created private (0600) and widened to the source mode below.
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile((plan.bom ? UTF8_BOM : "") + plan.newContent);
      if (plan.fileExists) {
        // The replacement inode must carry the live file's identity, not the
        // caller's: its (possibly restrictive) mode, and — when the command
        // runs as another user (sudo, shared or dotfile-managed file) — its
        // uid/gid, or the harness user would lose write access to a file that
        // is now owned by the caller. Failing is the safe path when the
        // ownership cannot be applied.
        const source = await stat(writePath);
        await handle.chmod(source.mode & 0o777);
        if (
          process.getuid !== undefined &&
          process.getgid !== undefined &&
          (source.uid !== process.getuid() || source.gid !== process.getgid())
        ) {
          await handle.chown(source.uid, source.gid);
        }
      }
    } finally {
      await handle.close();
    }
  } catch (err) {
    await abandon();
    throw new CliError(
      "RUNTIME",
      `Write failed for ${writePath}: ${err instanceof Error ? err.message : String(err)}; the live file is unchanged.`
    );
  }

  // Second check — the backup and temp-file preparation above awaited several
  // times; a change that slipped in during those awaits must not be replaced.
  // This is the LAST await before the rename.
  try {
    await assertUnchanged("final");
  } catch (err) {
    await abandon();
    throw err;
  }

  try {
    await rename(tempPath, writePath);
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw new CliError(
      "RUNTIME",
      `Write failed for ${writePath}: ${err instanceof Error ? err.message : String(err)}; the live file is unchanged` +
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
