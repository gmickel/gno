#!/usr/bin/env bun
// node:path: Bun has no path join helpers.
import { join } from "node:path";

interface HarnessConfig {
  id: string;
  allowedRoots: string[];
  budget: {
    maxRuntimeMinutes: number;
    maxChangedFiles: number;
  };
  metric: {
    baselineArtifact: string;
    validationCommand: string;
    smokeCommand: string;
    promotionSplit: string;
  };
  logging: {
    runDir: string;
  };
}

interface RunArtifact {
  experimentId: string;
  mode: "noop";
  policyId: string;
  commitSha: string;
  changedFiles: string[];
  metricCommand: string;
  budgetMinutes: number;
  runtimeSeconds: number;
  decision: "discard";
  rationale: string;
}

const repoRoot = join(import.meta.dir, "../../../..");
const configPath = join(repoRoot, "research/finetune/autonomous/config.json");

function parseStatusPaths(statusText: string): string[] {
  return statusText
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function isAllowed(path: string, allowedRoots: string[]): boolean {
  return allowedRoots.some((root) => path.startsWith(root));
}

async function sh(command: string): Promise<string> {
  return (await Bun.$`${{ raw: command }}`.text()).trim();
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const config = (await Bun.file(configPath).json()) as HarnessConfig;
  const beforeStatus = await sh("git status --short --untracked-files=all");
  const beforePaths = new Set(parseStatusPaths(beforeStatus));
  const commitSha = await sh("git rev-parse HEAD");

  const now = new Date();
  const stamp = now.toISOString().replace(/[:]/g, "-");
  const experimentId = `noop-${stamp}`;
  const runPath = join(repoRoot, config.logging.runDir, `${experimentId}.json`);

  const provisional: RunArtifact = {
    experimentId,
    mode: "noop",
    policyId: config.id,
    commitSha,
    changedFiles: [],
    metricCommand: `${config.metric.validationCommand} && ${config.metric.smokeCommand}`,
    budgetMinutes: config.budget.maxRuntimeMinutes,
    runtimeSeconds: 0,
    decision: "discard",
    rationale: "Boundary proof only. No mutation attempted.",
  };

  await Bun.write(runPath, `${JSON.stringify(provisional, null, 2)}\n`);

  const afterStatus = await sh("git status --short --untracked-files=all");
  const afterPaths = parseStatusPaths(afterStatus);
  const changedFiles = afterPaths.filter((path) => !beforePaths.has(path));

  if (changedFiles.some((path) => !isAllowed(path, config.allowedRoots))) {
    throw new Error(`noop run escaped sandbox: ${changedFiles.join(", ")}`);
  }
  if (changedFiles.length > config.budget.maxChangedFiles) {
    throw new Error(`noop run exceeded change budget: ${changedFiles.length}`);
  }

  const artifact: RunArtifact = {
    ...provisional,
    changedFiles,
    runtimeSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(2)),
  };

  await Bun.write(runPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Wrote noop run artifact: ${runPath}`);
}

await main();
