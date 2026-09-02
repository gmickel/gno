/**
 * `gno agents` command runners: install, update, verify, uninstall.
 *
 * @module src/cli/commands/agents/commands
 */

import { CliError } from "../../errors.js";
import { getGlobals } from "../../program.js";
import {
  BLOCK_VERSION,
  extractBlock,
  renderBlock,
  stampAuthenticates,
} from "./block.js";
import {
  applyPlan,
  decodeInstructionFile,
  type PlanMode,
  planTargets,
  planWrites,
  type TargetPlan,
  unifiedDiff,
} from "./engine.js";
import {
  type HarnessId,
  HARNESS_IDS,
  type ResolvedTarget,
  resolveTargets,
} from "./harnesses.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentsOptions {
  target?: HarnessId | "all";
  extraDirs?: string[];
  dryRun?: boolean;
  json?: boolean;
  quiet?: boolean;
  /** Override for testing / sandboxed live verification. */
  homeDir?: string;
}

function safeGetGlobals(): { json: boolean; quiet: boolean } {
  try {
    return getGlobals();
  } catch {
    return { json: false, quiet: false };
  }
}

export function parseTargetOption(raw: string): HarnessId | "all" {
  if (raw === "all" || (HARNESS_IDS as string[]).includes(raw)) {
    return raw as HarnessId | "all";
  }
  throw new CliError(
    "VALIDATION",
    `Invalid target: ${raw}. Must be one of ${HARNESS_IDS.join(", ")}, or 'all'.`
  );
}

function outputSettings(opts: AgentsOptions): {
  json: boolean;
  quiet: boolean;
} {
  const globals = safeGetGlobals();
  return {
    json: opts.json ?? globals.json,
    quiet: opts.quiet ?? globals.quiet,
  };
}

interface TargetReport {
  target: string;
  label: string;
  path: string;
  action: string;
  detected: boolean;
  via?: string;
  detail?: string;
  backup?: string | null;
}

function reportFor(
  plan: TargetPlan,
  backup: string | null | undefined
): TargetReport {
  return {
    target: plan.target.id,
    label: plan.target.label,
    path: plan.target.file,
    action: plan.action,
    detected: plan.target.detected,
    ...(plan.via && { via: plan.via }),
    ...(plan.detail && { detail: plan.detail }),
    ...(backup !== undefined && { backup }),
  };
}

function printHumanReports(reports: TargetReport[]): void {
  for (const r of reports) {
    const via = r.via ? ` (${r.detail ?? `via ${r.via}`})` : "";
    const detail = !r.via && r.detail ? `: ${r.detail}` : "";
    process.stdout.write(
      `${r.action.padEnd(12)} ${r.target.padEnd(10)} ${r.path}${via}${detail}\n`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Install / Update / Uninstall (shared mutation runner)
// ─────────────────────────────────────────────────────────────────────────────

async function runMutation(
  verb: "install" | "update" | "uninstall",
  mode: PlanMode,
  opts: AgentsOptions
): Promise<void> {
  const { json, quiet } = outputSettings(opts);
  const dryRun = opts.dryRun ?? false;

  const targets = resolveTargets(opts.target ?? "all", {
    homeDir: opts.homeDir,
    extraDirs: opts.extraDirs,
  });
  const plans = await planTargets(targets, mode);

  const reports: TargetReport[] = [];
  const diffs: string[] = [];
  const failedPaths: string[] = [];
  let validationErrors = 0;

  for (const plan of plans) {
    if (plan.action === "error") {
      failedPaths.push(plan.target.file);
      if (plan.errorCode !== "RUNTIME") {
        validationErrors += 1;
      }
      reports.push(reportFor(plan, undefined));
      continue;
    }
    if (!planWrites(plan)) {
      reports.push(reportFor(plan, undefined));
      continue;
    }
    if (dryRun) {
      diffs.push(
        unifiedDiff(plan.oldContent, plan.newContent, plan.target.file)
      );
      reports.push(reportFor(plan, null));
      continue;
    }
    // A failing write must not abort the run before the receipt is emitted:
    // earlier targets may already have been written, and the operator needs
    // to see exactly which. Record an `error` row and keep going.
    try {
      reports.push(reportFor(plan, await applyPlan(plan)));
    } catch (err) {
      failedPaths.push(plan.target.file);
      reports.push({
        ...reportFor(plan, undefined),
        action: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fallback: when the installer could not apply the block somewhere, hand
  // the operator the exact block to paste (install/update only — uninstall
  // guidance is in the per-target detail).
  const manualBlock =
    failedPaths.length > 0 && mode === "install" ? renderBlock() : undefined;

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          command: verb,
          blockVersion: BLOCK_VERSION,
          dryRun,
          results: reports,
          ...(dryRun && { diffs }),
          ...(manualBlock !== undefined && { manualBlock }),
        },
        null,
        2
      )}\n`
    );
  } else if (!quiet) {
    printHumanReports(reports);
    if (dryRun) {
      for (const diff of diffs) {
        if (diff) {
          process.stdout.write(`\n${diff}\n`);
        }
      }
      process.stdout.write("\nDry run — nothing was written.\n");
    }
    if (manualBlock !== undefined) {
      process.stdout.write(
        `\nCould not apply the block to: ${failedPaths.join(", ")}\n` +
          "Append this block to the file yourself (replacing any existing gno:agents block):\n\n" +
          `${manualBlock}\n`
      );
    }
  }

  if (failedPaths.length > 0) {
    // Exit-code contract (spec/cli.md): 1 = validation (malformed markers,
    // non-UTF-8), 2 = runtime (I/O). Any validation failure makes it 1.
    throw new CliError(
      validationErrors > 0 ? "VALIDATION" : "RUNTIME",
      `${verb} failed for ${failedPaths.length} target(s); see per-target detail above. Nothing was written to the failing file(s).`
    );
  }
}

/**
 * Install or refresh the protocol block. Both verbs converge the block to
 * the current release: install appends when absent, update replaces an
 * older/stale block in place; a current block is a no-op for either.
 */
export function installAgents(
  opts: AgentsOptions = {},
  verb: "install" | "update" = "install"
): Promise<void> {
  return runMutation(verb, "install", opts);
}

/** Remove the protocol block and its markers, leaving the rest untouched. */
export function uninstallAgents(opts: AgentsOptions = {}): Promise<void> {
  return runMutation("uninstall", "uninstall", opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Verify
// ─────────────────────────────────────────────────────────────────────────────

type VerifyStatus =
  | "ok"
  | "outdated"
  | "missing"
  | "malformed"
  | "error"
  | "covered"
  | "not-detected";

interface VerifyReport {
  target: string;
  label: string;
  path: string;
  status: VerifyStatus;
  detected: boolean;
  via?: string;
  detail?: string;
  blockVersion?: number;
  hashOk?: boolean;
}

/** Inner text (stamp + body, no markers) of the current release's block. */
function expectedInner(): string {
  return renderBlock().split("\n").slice(1, -1).join("\n");
}

async function verifyTarget(
  target: ResolvedTarget,
  runContext: {
    resolvedIds: Set<string>;
    requiredCovering: Set<string>;
    /** Real-file identity → id of the target that owns verification. */
    owners: Map<string, string>;
  }
): Promise<VerifyReport> {
  const base = {
    target: target.id,
    label: target.label,
    path: target.file,
    detected: target.detected,
  };

  if (!(target.detected || runContext.requiredCovering.has(target.id))) {
    return { ...base, status: "not-detected" };
  }
  if (target.coveredBy) {
    if (!runContext.resolvedIds.has(target.coveredBy)) {
      return {
        ...base,
        status: "missing",
        detail: `covered via ${target.coveredBy}, but ${target.coveredBy} was not resolved in this run`,
      };
    }
    return {
      ...base,
      status: "covered",
      via: target.coveredBy,
      detail: `covered via ${target.coveredBy}`,
    };
  }
  const owner = runContext.owners.get(target.realFile);
  if (owner) {
    return {
      ...base,
      status: "covered",
      via: owner,
      detail: `covered via ${owner} (same file)`,
    };
  }
  runContext.owners.set(target.realFile, target.id);

  const file = Bun.file(target.file);
  if (!(await file.exists())) {
    return { ...base, status: "missing", detail: "instruction file not found" };
  }
  let bytes: Uint8Array;
  try {
    bytes = await file.bytes();
  } catch (err) {
    return {
      ...base,
      status: "error",
      detail: `could not read instruction file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let extraction: ReturnType<typeof extractBlock>;
  try {
    const { content } = decodeInstructionFile(bytes, target.file);
    extraction = extractBlock(content, target.file);
  } catch (err) {
    return {
      ...base,
      status: "malformed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!extraction.found) {
    return { ...base, status: "missing", detail: "no GNO agents block" };
  }

  const { block } = extraction;
  const hashOk = stampAuthenticates(block);
  const versionOk = block.stamp?.version === BLOCK_VERSION;
  const isCurrent = versionOk && hashOk && block.inner === expectedInner();
  const versioned = { blockVersion: block.stamp?.version, hashOk };
  if (isCurrent) {
    return { ...base, status: "ok", ...versioned };
  }
  const detail = !block.stamp
    ? "block has no valid stamp line (missing or unparseable) — run `gno agents update`"
    : !hashOk
      ? "block content does not match its stamp hash (edited inside markers?) — run `gno agents update`"
      : !versionOk
        ? `block v${block.stamp?.version ?? "?"} does not match installed release v${BLOCK_VERSION} — run \`gno agents update\``
        : "block content differs from the installed release — run `gno agents update`";
  return { ...base, status: "outdated", ...versioned, detail };
}

export async function verifyAgents(opts: AgentsOptions = {}): Promise<void> {
  const { json, quiet } = outputSettings(opts);
  const targets = resolveTargets(opts.target ?? "all", {
    homeDir: opts.homeDir,
    extraDirs: opts.extraDirs,
  });

  const resolvedIds = new Set(targets.map((t) => t.id as string));
  const requiredCovering = new Set<string>();
  for (const t of targets) {
    if (t.detected && t.coveredBy) {
      requiredCovering.add(t.coveredBy);
    }
  }
  const owners = new Map<string, string>();
  const results: VerifyReport[] = [];
  for (const target of targets) {
    results.push(
      await verifyTarget(target, { resolvedIds, requiredCovering, owners })
    );
  }

  const failing = results.filter(
    (r) => !["ok", "covered", "not-detected"].includes(r.status)
  );
  const ok = failing.length === 0;

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        { command: "verify", blockVersion: BLOCK_VERSION, ok, results },
        null,
        2
      )}\n`
    );
  } else if (!quiet) {
    for (const r of results) {
      const detail = r.detail ? ` — ${r.detail}` : "";
      process.stdout.write(
        `${r.status.padEnd(13)} ${r.target.padEnd(10)} ${r.path}${detail}\n`
      );
    }
  }

  if (!ok) {
    // 2 when the only failures were unreadable files (could not check),
    // 1 for any content verdict (outdated / missing / malformed).
    const allRuntime = failing.every((r) => r.status === "error");
    throw new CliError(
      allRuntime ? "RUNTIME" : "VALIDATION",
      `verification failed for ${failing.length} target(s): ${failing
        .map((r) => `${r.target} (${r.status})`)
        .join(", ")}`
    );
  }
}
