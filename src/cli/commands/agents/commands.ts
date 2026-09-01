/**
 * `gno agents` command runners: install, update, verify, uninstall.
 *
 * @module src/cli/commands/agents/commands
 */

// node:fs existsSync used for synchronous link-resolution checks in verify.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CliError } from "../../errors.js";
import { getGlobals } from "../../program.js";
import {
  BLOCK_VERSION,
  extractBlock,
  extractFileReferences,
  hashBlockBody,
  renderBlock,
} from "./block.js";
import {
  applyPlan,
  type PlanMode,
  planTargets,
  planWrites,
  type TargetPlan,
  unifiedDiff,
} from "./engine.js";
import {
  ENV_AGENTS_HOME_OVERRIDE,
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
  let errors = 0;

  for (const plan of plans) {
    if (plan.action === "error") {
      errors += 1;
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
    const backup = await applyPlan(plan);
    reports.push(reportFor(plan, backup));
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          command: verb,
          blockVersion: BLOCK_VERSION,
          dryRun,
          results: reports,
          ...(dryRun && { diffs }),
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
  }

  if (errors > 0) {
    throw new CliError(
      "VALIDATION",
      `${verb} failed for ${errors} target(s); see per-target detail above. Nothing was written to the failing file(s).`
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

interface VerifyReport {
  target: string;
  label: string;
  path: string;
  status:
    | "ok"
    | "outdated"
    | "missing"
    | "malformed"
    | "covered"
    | "not-detected";
  detected: boolean;
  via?: string;
  detail?: string;
  blockVersion?: number;
  hashOk?: boolean;
  linksOk?: boolean;
  unresolvedLinks?: string[];
}

function expandHome(ref: string, home: string): string {
  return ref.startsWith("~") ? join(home, ref.slice(1)) : ref;
}

async function verifyTarget(
  target: ResolvedTarget,
  home: string
): Promise<VerifyReport> {
  const base: Pick<VerifyReport, "target" | "label" | "path" | "detected"> = {
    target: target.id,
    label: target.label,
    path: target.file,
    detected: target.detected,
  };

  if (!target.detected) {
    return { ...base, status: "not-detected" };
  }
  if (target.coveredBy) {
    return {
      ...base,
      status: "covered",
      via: target.coveredBy,
      detail: `covered via ${target.coveredBy}`,
    };
  }

  const file = Bun.file(target.file);
  if (!(await file.exists())) {
    return {
      ...base,
      status: "missing",
      detail: "instruction file not found",
    };
  }
  const content = await file.text();

  let extraction: ReturnType<typeof extractBlock>;
  try {
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
  const hashOk =
    block.stamp !== null && block.stamp.hash === hashBlockBody(block.body);
  // Expected inner text = current render for this target's skill state,
  // without the surrounding marker lines.
  const expectedInner = renderBlock({ skillInstalled: target.skillInstalled })
    .split("\n")
    .slice(1, -1)
    .join("\n");
  const isCurrent =
    block.stamp?.version === BLOCK_VERSION &&
    hashOk &&
    block.inner === expectedInner;

  const refs = extractFileReferences(block.body);
  const unresolved = refs.filter((ref) => !existsSync(expandHome(ref, home)));
  const linksOk = unresolved.length === 0;

  if (!isCurrent) {
    return {
      ...base,
      status: "outdated",
      blockVersion: block.stamp?.version,
      hashOk,
      linksOk,
      ...(unresolved.length > 0 && { unresolvedLinks: unresolved }),
      detail: (() => {
        if (!hashOk) {
          return "block content does not match its stamp hash (edited inside markers?) — run `gno agents update`";
        }
        if (block.stamp?.version !== BLOCK_VERSION) {
          return `block v${block.stamp?.version ?? "?"} does not match installed release v${BLOCK_VERSION} — run \`gno agents update\``;
        }
        return "block content differs from the installed release's render (e.g. skill pointer changed) — run `gno agents update`";
      })(),
    };
  }

  return {
    ...base,
    status: linksOk ? "ok" : "outdated",
    blockVersion: block.stamp?.version,
    hashOk,
    linksOk,
    ...(unresolved.length > 0 && {
      unresolvedLinks: unresolved,
      detail: `unresolved file reference(s): ${unresolved.join(", ")}`,
    }),
  };
}

export async function verifyAgents(opts: AgentsOptions = {}): Promise<void> {
  const { json, quiet } = outputSettings(opts);
  const home =
    opts.homeDir ?? process.env[ENV_AGENTS_HOME_OVERRIDE] ?? homedir();

  const targets = resolveTargets(opts.target ?? "all", {
    homeDir: opts.homeDir,
    extraDirs: opts.extraDirs,
  });

  const results: VerifyReport[] = [];
  for (const target of targets) {
    results.push(await verifyTarget(target, home));
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
    throw new CliError(
      "VALIDATION",
      `verification failed for ${failing.length} target(s): ${failing
        .map((r) => `${r.target} (${r.status})`)
        .join(", ")}`
    );
  }
}
