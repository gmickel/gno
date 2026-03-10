#!/usr/bin/env bun
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { stdout } from "node:process";

import { parseValLossRecords } from "../../lib/run-selection";
import {
  loadHarnessConfig,
  type HarnessConfig,
  type SearchSpace,
} from "../lib/results";
import { shouldEarlyStop, type EarlyStopDecision } from "../lib/training-guard";

const repoRoot = join(import.meta.dir, "../../../..");
const candidateId = process.argv[2];
if (!candidateId) {
  throw new Error(
    "Usage: bun run research:finetune:autonomous:run-candidate <candidate-id>"
  );
}

const searchSpace = (await Bun.file(
  join(repoRoot, "research/finetune/autonomous/search-space.json")
).json()) as SearchSpace;
const harnessConfig = await loadHarnessConfig(repoRoot);
const candidate = searchSpace.candidates.find(
  (item) => item.id === candidateId
);
if (!candidate) {
  throw new Error(`Unknown candidate: ${candidateId}`);
}

const baseConfig = Bun.YAML.parse(
  await Bun.file(join(repoRoot, searchSpace.baseTrainingConfig)).text()
) as Record<string, unknown>;

const datasetOutput = `research/finetune/data/autonomous-${candidate.id}`;
const runName = `auto-${candidate.id}`;
const logPath = join(
  repoRoot,
  `research/finetune/outputs/logs/${runName}-${timestampForPath()}.log`
);
const trainingConfigPath = join(
  repoRoot,
  `research/finetune/autonomous/runs/${runName}.yaml`
);
const adapterOutputPath = join(
  repoRoot,
  `research/finetune/outputs/${runName}`
);

await mkdir(join(repoRoot, "research/finetune/autonomous/runs"), {
  recursive: true,
});
await mkdir(join(repoRoot, "research/finetune/outputs/logs"), {
  recursive: true,
});
await rm(adapterOutputPath, { force: true, recursive: true });
await rm(join(repoRoot, `research/finetune/outputs/${runName}-best-fused`), {
  force: true,
  recursive: true,
});
await rm(
  join(repoRoot, `research/finetune/outputs/${runName}-best-fused-deq`),
  {
    force: true,
    recursive: true,
  }
);

const trainConfig = {
  ...baseConfig,
  data: datasetOutput,
  adapter_path: `research/finetune/outputs/${runName}`,
  learning_rate: candidate.learningRate,
};
await Bun.write(trainingConfigPath, Bun.YAML.stringify(trainConfig));

const commands: Array<{ label: string; cmd: string[] }> = [
  {
    label: "build-dataset",
    cmd: [
      "bun",
      "research/finetune/scripts/build-mlx-dataset.ts",
      "--mix",
      candidate.mix,
      "--prompt_profile",
      candidate.promptProfile,
      "--output",
      datasetOutput,
    ],
  },
];

for (const step of commands) {
  console.log(`\n==> ${step.label}`);
  const [bin, ...args] = step.cmd;
  const result = Bun.spawnSync({
    cmd: [bin!, ...args],
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

console.log(`\n==> train`);
const earlyStop = await runTraining({
  trainingConfigPath,
  logPath,
  guard: resolveGuard(harnessConfig),
});

console.log(`\n==> promote`);
const promoteResult = Bun.spawnSync({
  cmd: ["bun", "run", "research:finetune:promote", runName],
  cwd: repoRoot,
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
if (promoteResult.exitCode !== 0) {
  process.exit(promoteResult.exitCode);
}

const benchmarkSummary = (await Bun.file(
  join(repoRoot, `research/finetune/outputs/${runName}/benchmark-summary.json`)
).json()) as { candidates: Array<Record<string, unknown>> };

const resultPath = join(
  repoRoot,
  `research/finetune/autonomous/runs/${runName}.result.json`
);
await Bun.write(
  resultPath,
  `${JSON.stringify(
    {
      runName,
      candidateId,
      mix: candidate.mix,
      promptProfile: candidate.promptProfile,
      learningRate: candidate.learningRate,
      logPath,
      benchmark: benchmarkSummary.candidates[0],
      trainingConfigPath,
      earlyStop:
        earlyStop.stop && earlyStop.iteration
          ? {
              iteration: earlyStop.iteration,
              bestValLoss: Number(earlyStop.bestValLoss.toFixed(3)),
              threshold: Number(earlyStop.threshold.toFixed(3)),
              reason: earlyStop.reason ?? "early stop",
            }
          : undefined,
    },
    null,
    2
  )}\n`
);

console.log(resultPath);

function resolveGuard(config: HarnessConfig) {
  const earlyStop = config.search?.earlyStop;
  if (!earlyStop?.enabled) {
    return undefined;
  }
  return {
    ...earlyStop,
    referenceBestValLoss: config.search?.referenceBestValLoss,
  };
}

async function runTraining(input: {
  trainingConfigPath: string;
  logPath: string;
  guard?: ReturnType<typeof resolveGuard>;
}): Promise<EarlyStopDecision> {
  await Bun.write(input.logPath, "");
  const writer = Bun.file(input.logPath).writer();
  const command = `PYTHONUNBUFFERED=1 python3 -u -m mlx_lm lora --train --config '${input.trainingConfigPath}' 2>&1`;
  const proc = Bun.spawn({
    cmd: ["sh", "-lc", command],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "inherit",
    env: process.env,
  });
  const decoder = new TextDecoder();
  const records = [];
  let buffered = "";
  let pendingStop: EarlyStopDecision | null = null;
  let earlyStop: EarlyStopDecision = {
    stop: false,
    bestValLoss: Number.POSITIVE_INFINITY,
    threshold: Number.POSITIVE_INFINITY,
  };

  const reader = proc.stdout.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    stdout.write(value);
    await writer.write(value);
    buffered += decoder.decode(value, { stream: true });

    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parseValLossRecords(`${line}\n`);
      if (parsed.length === 0) {
        const savedIteration = parseSavedIteration(line);
        if (
          pendingStop?.stop &&
          pendingStop.iteration !== undefined &&
          savedIteration === pendingStop.iteration
        ) {
          earlyStop = pendingStop;
          proc.kill();
          break;
        }
        continue;
      }
      records.push(...parsed);
      const decision = shouldEarlyStop(records, input.guard);
      if (decision.stop) {
        pendingStop = decision;
      }
    }
    if (earlyStop.stop) {
      break;
    }
  }

  if (buffered.length > 0) {
    stdout.write(`${buffered}\n`);
    await writer.write(`${buffered}\n`);
    const parsed = parseValLossRecords(`${buffered}\n`);
    if (parsed.length > 0) {
      records.push(...parsed);
      earlyStop = shouldEarlyStop(records, input.guard);
    }
  }

  await writer.flush();
  await writer.end();

  const exitCode = await proc.exited;
  if (pendingStop?.stop && !earlyStop.stop) {
    earlyStop = pendingStop;
  }
  if (exitCode !== 0 && !pendingStop?.stop) {
    process.exit(exitCode);
  }
  if (earlyStop.stop) {
    console.log(`Early stop: ${earlyStop.reason}`);
  }

  return earlyStop;
}

function timestampForPath(): string {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
}

function parseSavedIteration(line: string): number | null {
  const match = /Iter (\d+): Saved adapter weights/.exec(line);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1]!, 10);
}
