/**
 * `gno agents` command runners: install, update, verify, uninstall.
 *
 * @module src/cli/commands/agents/commands
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { CliError } from "../../errors.js";
import { getGlobals } from "../../program.js";
import {
  BLOCK_VERSION,
  extractBlock,
  extractFileReferences,
  renderBlock,
  type SkillRemediation,
  stampAuthenticates,
} from "./block.js";
import {
  aggregateRemediation,
  aggregateSkillInstalled,
  applyPlan,
  decodeInstructionFile,
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

/**
 * Consumer aggregation universe for skill-state rendering: the FULL harness
 * matrix (plus any extra dirs), independent of the requested target filter.
 * An explicit-target run still only writes the requested targets' files, but
 * the skill pointer rendered into a shared real file must account for EVERY
 * detected consumer of that file (e.g. OpenCode's AGENTS.md symlinked to
 * Codex's) — otherwise `install --target codex` emits `/gno` into a file an
 * unrequested harness without the skill also reads, and a later
 * `verify --target all` reports the fresh block outdated.
 */
function aggregateSkillState(
  requested: HarnessId | "all",
  requestedTargets: ResolvedTarget[],
  opts: AgentsOptions,
  mode: PlanMode = "install"
): {
  skillByFile: Map<string, boolean>;
  remediationByFile: Map<string, SkillRemediation>;
} {
  // Uninstall renders no block, so it needs no skill-state aggregation — and
  // must not touch (or be aborted by) harnesses the operator did not request.
  if (mode === "uninstall") {
    return { skillByFile: new Map(), remediationByFile: new Map() };
  }
  // The aggregation universe is resolved leniently: an unrequested harness
  // with misconfigured env (e.g. a relative CLAUDE_CONFIG_DIR) is dropped from
  // the aggregation rather than aborting an explicit-target run. Requested
  // targets were already resolved strictly by the caller.
  const universe =
    requested === "all"
      ? requestedTargets
      : resolveTargets("all", {
          homeDir: opts.homeDir,
          extraDirs: opts.extraDirs,
          lenient: true,
        });
  return {
    skillByFile: aggregateSkillInstalled(universe),
    remediationByFile: aggregateRemediation(universe),
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

  const requested = opts.target ?? "all";
  const targets = resolveTargets(requested, {
    homeDir: opts.homeDir,
    extraDirs: opts.extraDirs,
  });
  const aggregated = aggregateSkillState(requested, targets, opts, mode);
  const plans = await planTargets(
    targets,
    mode,
    aggregated.skillByFile,
    aggregated.remediationByFile
  );

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
    // A failing apply (backup error, concurrent edit detected, write error)
    // must not abort the run before the receipt is emitted: earlier targets
    // may already have been written, and the operator needs to see exactly
    // which. Record an `error` row and keep going; the accumulated receipt is
    // printed below and the run still exits non-zero.
    try {
      const backup = await applyPlan(plan);
      reports.push(reportFor(plan, backup));
    } catch (err) {
      errors += 1;
      reports.push({
        ...reportFor(plan, undefined),
        action: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
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
  home: string,
  runContext: {
    resolvedIds: Set<string>;
    requiredCovering: Set<string>;
    /** Real-file identity → id of the target that owns verification. */
    owners: Map<string, string>;
    /** Real-file identity → all detected consumers have the skill. */
    skillByFile: Map<string, boolean>;
    /** Real-file identity → consumers lacking the skill (remediation). */
    remediationByFile: Map<string, SkillRemediation>;
  }
): Promise<VerifyReport> {
  const base: Pick<VerifyReport, "target" | "label" | "path" | "detected"> = {
    target: target.id,
    label: target.label,
    path: target.file,
    detected: target.detected,
  };

  // A covering target required by a detected covered target (grok → claude)
  // is verified even when its own harness is not detected on this machine.
  if (!(target.detected || runContext.requiredCovering.has(target.id))) {
    return { ...base, status: "not-detected" };
  }
  if (target.coveredBy) {
    // Coverage is only truthful when the covering target is verified in the
    // same run — its own row carries the actual block status.
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

  // Same-real-file dedupe, mirroring installation ownership: the first
  // non-covered target owns the write (and rendered the block with its own
  // skill state), so it also owns verification. Verifying the shared file
  // again under a different target's expectations would falsely report the
  // block outdated when the two targets' skill pointers differ.
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
    return {
      ...base,
      status: "missing",
      detail: "instruction file not found",
    };
  }
  let content: string;
  let extraction: ReturnType<typeof extractBlock>;
  try {
    // Same byte-exact decoder as planning: BOM split off, non-UTF-8 refused.
    ({ content } = decodeInstructionFile(await file.bytes(), target.file));
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
  // The stamp hash covers body + separator-provenance token, so a stripped or
  // forged token fails here rather than being mirrored into the render below.
  const hashOk = stampAuthenticates(block);
  // Expected inner text = current render for this file's aggregated skill
  // state and remediation set (every detected consumer of the shared real
  // file, mirroring what install renders), without the marker lines. The
  // separator token is install-time provenance — mirrored only once
  // authenticated.
  const expectedInner = renderBlock({
    skillInstalled:
      runContext.skillByFile.get(target.realFile) ?? target.skillInstalled,
    separator: hashOk ? block.stamp?.separator : undefined,
    remediation: runContext.remediationByFile.get(target.realFile),
  })
    .split("\n")
    .slice(1, -1)
    .join("\n");
  const isCurrent =
    block.stamp?.version === BLOCK_VERSION &&
    hashOk &&
    block.inner === expectedInner;

  const refs = extractFileReferences(block.body);
  const unresolved: string[] = [];
  for (const ref of refs) {
    if (!(await Bun.file(expandHome(ref, home)).exists())) {
      unresolved.push(ref);
    }
  }
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

  const requested = opts.target ?? "all";
  const targets = resolveTargets(requested, {
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
  const { skillByFile, remediationByFile } = aggregateSkillState(
    requested,
    targets,
    opts
  );
  const results: VerifyReport[] = [];
  for (const target of targets) {
    results.push(
      await verifyTarget(target, home, {
        resolvedIds,
        requiredCovering,
        owners,
        skillByFile,
        remediationByFile,
      })
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
    throw new CliError(
      "VALIDATION",
      `verification failed for ${failing.length} target(s): ${failing
        .map((r) => `${r.target} (${r.status})`)
        .join(", ")}`
    );
  }
}
