// node:fs/promises provides filesystem structure operations; Bun has no equivalents.
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
// node:path provides path joining; Bun has no path utilities.
import { dirname, join } from "node:path";

import type { OuterAgentFactory } from "./agent";
import type { LoadedAgenticFixture } from "./fixture-db";
import type { BenchmarkArtifacts } from "./report-artifacts";
import type { CapsuleReplayRecord } from "./types";

import { AgenticHarnessError } from "./adapter";
import { AGENTIC_CLI_HELP, parseAgenticCliOptions } from "./cli-options";
import { FixtureAgentFactory } from "./fixture-agent";
import { AGENTIC_FIXTURE_ROOT, loadAgenticFixture } from "./fixture-db";
import { LocalModelAgentFactory } from "./local-model-agent";
import {
  createAgenticAdapterFactories,
  DEFAULT_AGENTIC_ADAPTER_IDS,
} from "./registry";
import {
  buildBenchmarkReport,
  buildCapsuleReplayRecords,
  createBenchmarkEnvironment,
} from "./report";
import {
  createBenchmarkArtifacts,
  renderBenchmarkMarkdown,
} from "./report-artifacts";
import { runAgenticBenchmark } from "./runner";

const BASELINE_ROOT = join(AGENTIC_FIXTURE_ROOT, "baseline");

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  [...left].sort().every((value, index) => value === [...right].sort()[index]);

const artifactLane = (input: {
  adapterIds: readonly string[];
  taskIds: readonly string[];
  allTaskIds: readonly string[];
  lifecycles: readonly string[];
  agent: "fixture" | "local-model";
}): string | null => {
  const fullTasks = sameSet(input.taskIds, input.allTaskIds);
  const fullLifecycle = sameSet(input.lifecycles, ["cold", "warm"]);
  if (!(fullTasks && fullLifecycle)) return null;
  if (
    input.agent === "fixture" &&
    sameSet(input.adapterIds, DEFAULT_AGENTIC_ADAPTER_IDS)
  )
    return join(BASELINE_ROOT, "fixture-agent");
  if (input.agent === "fixture" && sameSet(input.adapterIds, ["qmd"]))
    return join(BASELINE_ROOT, "optional", "qmd");
  if (
    input.agent === "local-model" &&
    sameSet(input.adapterIds, DEFAULT_AGENTIC_ADAPTER_IDS)
  )
    return join(BASELINE_ROOT, "optional", "local-model");
  return null;
};

export const writeBenchmarkArtifacts = async (
  directory: string,
  artifacts: BenchmarkArtifacts
): Promise<void> => {
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".agentic-stage-"));
  const backup = `${staging}.previous`;
  let movedPrevious = false;
  try {
    const paths = [
      join(staging, "report.json"),
      join(staging, "canonical.json"),
      join(staging, "observations.json"),
      join(staging, "report.md"),
    ];
    await Promise.all([
      Bun.write(paths[0]!, artifacts.reportJson),
      Bun.write(paths[1]!, artifacts.canonicalJson),
      Bun.write(paths[2]!, artifacts.observationsJson),
      Bun.write(paths[3]!, artifacts.reportMarkdown),
    ]);
    const formatter = Bun.spawn([process.execPath, "x", "oxfmt", ...paths], {
      cwd: join(import.meta.dir, "../.."),
      stdout: "ignore",
      stderr: "pipe",
    });
    const [formatterExit, formatterError] = await Promise.all([
      formatter.exited,
      new Response(formatter.stderr).text(),
    ]);
    if (formatterExit !== 0)
      throw new Error(
        `Artifact formatting failed: ${formatterError.trim() || `exit ${formatterExit}`}`
      );
    try {
      await rename(directory, backup);
      movedPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, directory);
    } catch (error) {
      if (movedPrevious) await rename(backup, directory);
      throw error;
    }
    if (movedPrevious) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

export interface AgenticCliDependencies {
  loadFixture: () => Promise<LoadedAgenticFixture>;
  createAgentFactory: (agent: "fixture" | "local-model") => OuterAgentFactory;
  runBenchmark: typeof runAgenticBenchmark;
  writeArtifacts: typeof writeBenchmarkArtifacts;
  stdout: Pick<typeof process.stdout, "write">;
  stderr: Pick<typeof process.stderr, "write">;
}

const defaultDependencies: AgenticCliDependencies = {
  loadFixture: loadAgenticFixture,
  createAgentFactory: (agent) =>
    agent === "fixture"
      ? new FixtureAgentFactory()
      : new LocalModelAgentFactory(),
  runBenchmark: runAgenticBenchmark,
  writeArtifacts: writeBenchmarkArtifacts,
  stdout: process.stdout,
  stderr: process.stderr,
};

export const runAgenticCli = async (
  argv: readonly string[],
  overrides: Partial<AgenticCliDependencies> = {}
): Promise<number> => {
  const dependencies = { ...defaultDependencies, ...overrides };
  try {
    const options = parseAgenticCliOptions(argv);
    if (options.help) {
      dependencies.stdout.write(AGENTIC_CLI_HELP);
      return 0;
    }
    const fixture = await dependencies.loadFixture();
    const allTaskIds = [...fixture.tasks.keys()].sort();
    const taskIds = options.taskIds ?? allTaskIds;
    if (taskIds.some((taskId) => !fixture.tasks.has(taskId)))
      throw new AgenticHarnessError(
        "task_not_found",
        "--task contains an unknown fixture task"
      );
    const lane = artifactLane({
      adapterIds: options.adapterIds,
      taskIds,
      allTaskIds,
      lifecycles: options.lifecycles,
      agent: options.agent,
    });
    if (options.write && !lane)
      throw new AgenticHarnessError(
        "unsafe_baseline_write",
        "--write requires one complete authoritative or optional lane"
      );
    const agentFactory = dependencies.createAgentFactory(options.agent);
    const trials = [...(await agentFactory.trials())].sort((left, right) =>
      left.trialId.localeCompare(right.trialId, "en")
    );
    const result = await dependencies.runBenchmark({
      adapters: createAgenticAdapterFactories(options.adapterIds),
      adapterIds: options.adapterIds,
      agentFactory,
      fixture,
      taskIds,
      lifecycles: options.lifecycles,
      callTimeoutMs: options.timeoutMs,
    });
    let capsuleReplays: CapsuleReplayRecord[] = [];
    if (options.adapterIds.includes("capsule")) {
      const replay = await dependencies.runBenchmark({
        adapters: createAgenticAdapterFactories(["capsule"]),
        adapterIds: ["capsule"],
        agentFactory,
        fixture,
        taskIds,
        lifecycles: options.lifecycles,
        callTimeoutMs: options.timeoutMs,
      });
      capsuleReplays = buildCapsuleReplayRecords(
        result.receipts.filter(
          (receipt) => receipt.canonical.adapterId === "capsule"
        ),
        replay.receipts
      );
    }
    const report = buildBenchmarkReport({
      result,
      fixture,
      environment: createBenchmarkEnvironment({
        fixture,
        agentId: agentFactory.agentId,
        trials,
      }),
      capsuleReplays,
      expected: {
        adapterIds: options.adapterIds,
        taskIds,
        lifecycles: options.lifecycles,
        trials,
      },
    });
    dependencies.stdout.write(renderBenchmarkMarkdown(report));
    if (options.write && lane)
      await dependencies.writeArtifacts(lane, createBenchmarkArtifacts(report));
    if (
      report.receipts.some(
        (receipt) => receipt.canonical.failure.class === "harness_error"
      )
    )
      return 2;
    if (report.promotion && !report.promotion.passed) return 1;
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr.write(`Agentic benchmark error: ${message}\n`);
    return 2;
  }
};

if (import.meta.main) process.exit(await runAgenticCli(process.argv.slice(2)));
