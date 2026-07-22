import type {
  AgentAdapter,
  AgentAdapterFactory,
  AdapterPreparation,
  AdapterResetResult,
  AgentToolDefinition,
} from "./adapter";
import type { OuterAgentFactory } from "./agent";
import type { AgentTask, TrajectoryReceipt } from "./types";

import {
  AgenticHarnessError,
  CANONICAL_AGENT_TOOLS,
  fingerprintTools,
  validateAdapterCapabilities,
  validateAdapterPreparation,
} from "./adapter";
import { assertSha256, canonicalFingerprint } from "./canonical";
import { FixtureAgentFactory } from "./fixture-agent";
import { loadAgenticFixture, type LoadedAgenticFixture } from "./fixture-db";
import {
  attachPreparedAdapter,
  disposeWithin,
  listToolsWithin,
  selectAgenticTasks,
  withAbortTimeout,
} from "./runner-contract";
import { createHarnessFailureReceipt } from "./runner-receipt";
import { runAgentTrial } from "./runner-trial";
import {
  validateAdapterResetResult,
  validateAgentRuntimeStart,
  validateRunMatrix,
} from "./runner-validation";

const DEFAULT_TIMEOUT_MS = 30_000;
const WARM_STATE_UNKNOWN_CODES = new Set([
  "tool_timeout",
  "tool_call_failed",
  "invalid_tool_result",
]);

export interface AgenticRunnerOptions {
  adapters: Readonly<Record<string, AgentAdapterFactory>>;
  agentFactory?: OuterAgentFactory;
  fixture?: LoadedAgenticFixture;
  taskIds?: readonly string[];
  adapterIds?: readonly string[];
  lifecycles?: readonly ("cold" | "warm")[];
  callTimeoutMs?: number;
  recordedAt?: () => string;
}

export interface AgenticRunnerResult {
  receipts: TrajectoryReceipt[];
  preparations: Array<Omit<AdapterPreparation, "handle">>;
  canonicalFingerprint: string;
}

export const runAgenticBenchmark = async (
  options: AgenticRunnerOptions
): Promise<AgenticRunnerResult> => {
  const fixture = options.fixture ?? (await loadAgenticFixture());
  const tasks = selectAgenticTasks(fixture, options.taskIds);
  const agentFactory = options.agentFactory ?? new FixtureAgentFactory();
  if (!agentFactory.agentId.trim()) {
    throw new AgenticHarnessError(
      "invalid_agent_identity",
      "Outer agent identity must be nonempty"
    );
  }
  const timeoutMs = options.callTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AgenticHarnessError(
      "invalid_runner_timeout",
      "Runner timeout must be a positive finite number"
    );
  }
  const trials = [
    ...(await withAbortTimeout(
      () => Promise.resolve(agentFactory.trials()),
      timeoutMs,
      new AgenticHarnessError(
        "agent_trial_schedule_timeout",
        "Outer agent trial schedule timed out"
      )
    )),
  ];
  const adapterIds = (options.adapterIds ?? Object.keys(options.adapters))
    .slice()
    .sort();
  const lifecycles = options.lifecycles ?? ["cold", "warm"];
  validateRunMatrix({ adapterIds, lifecycles, trials, timeoutMs });
  trials.sort((left, right) => left.trialId.localeCompare(right.trialId, "en"));
  const recordedAt = options.recordedAt ?? (() => new Date().toISOString());
  const receipts: TrajectoryReceipt[] = [];
  const preparations: Array<Omit<AdapterPreparation, "handle">> = [];
  const canonicalToolsFingerprint = fingerprintTools(CANONICAL_AGENT_TOOLS);

  for (const adapterId of adapterIds) {
    const factory = options.adapters[adapterId];
    if (!factory)
      throw new AgenticHarnessError(
        "adapter_not_registered",
        `Unknown adapter: ${adapterId}`
      );
    const owner = factory();
    if (owner.adapterId !== adapterId) {
      throw new AgenticHarnessError(
        "adapter_identity_mismatch",
        `Factory ${adapterId} returned ${owner.adapterId}`
      );
    }
    validateAdapterCapabilities(owner.capabilities);
    assertSha256(owner.configFingerprint, "Adapter config fingerprint");
    const expectedAdapter = {
      adapterId,
      configFingerprint: owner.configFingerprint,
      capabilities: structuredClone(owner.capabilities),
    };
    let preparation: AdapterPreparation;
    try {
      preparation = await withAbortTimeout(
        (signal) =>
          owner.prepare({
            snapshot: fixture.snapshot,
            prepared: null,
            signal,
          }),
        timeoutMs,
        new AgenticHarnessError(
          "adapter_preparation_timeout",
          "Adapter preparation timed out"
        )
      );
      validateAdapterPreparation(preparation, adapterId, fixture.snapshot);
      const tools = await listToolsWithin(owner, timeoutMs);
      const toolsFingerprint = fingerprintTools(tools);
      if (canonicalToolsFingerprint !== toolsFingerprint) {
        throw new AgenticHarnessError(
          "tool_schema_mismatch",
          "Adapter must expose the canonical normalized tool schemas"
        );
      }
      const { handle: _handle, ...serializablePreparation } = preparation;
      preparations.push(structuredClone(serializablePreparation));
    } catch (error) {
      await disposeWithin(() => owner.dispose(), timeoutMs);
      for (const lifecycle of lifecycles) {
        for (const trial of trials) {
          for (const task of tasks) {
            receipts.push(
              createHarnessFailureReceipt({
                task,
                adapterId,
                trial,
                lifecycle,
                corpusFingerprint: fixture.snapshot.fingerprint,
                configFingerprint: owner.configFingerprint,
                capabilities: owner.capabilities,
                toolsFingerprint: canonicalToolsFingerprint,
                recordedAt,
                code: "adapter_preparation_failed",
                error,
              })
            );
          }
        }
      }
      continue;
    }

    try {
      for (const lifecycle of lifecycles) {
        if (lifecycle === "cold") {
          for (const trial of trials) {
            for (const task of tasks) {
              const e2eStarted = performance.now();
              let adapter: AgentAdapter | null = null;
              let agentStart: Awaited<
                ReturnType<OuterAgentFactory["open"]>
              > | null = null;
              try {
                adapter = await attachPreparedAdapter(
                  factory,
                  fixture,
                  preparation,
                  timeoutMs,
                  expectedAdapter
                );
                const tools = await listToolsWithin(adapter, timeoutMs);
                if (fingerprintTools(tools) !== canonicalToolsFingerprint) {
                  throw new AgenticHarnessError(
                    "tool_schema_mismatch",
                    "Attached adapter changed the canonical tool schemas"
                  );
                }
                const reset = await withAbortTimeout(
                  (signal) =>
                    adapter?.reset({
                      task,
                      lifecycle,
                      readinessProbe: false,
                      signal,
                    }) as Promise<AdapterResetResult>,
                  timeoutMs,
                  new AgenticHarnessError(
                    "adapter_reset_timeout",
                    "Cold adapter reset timed out"
                  )
                );
                validateAdapterResetResult(reset);
                agentStart = await withAbortTimeout(
                  (signal) => agentFactory.open(signal),
                  timeoutMs,
                  new AgenticHarnessError(
                    "agent_preflight_timeout",
                    "Outer agent preflight timed out"
                  )
                );
                validateAgentRuntimeStart(agentStart, agentFactory.agentId);
                receipts.push(
                  await runAgentTrial({
                    task,
                    adapter,
                    preparation,
                    tools,
                    agentRuntime: agentStart.runtime,
                    expectedAgentId: agentFactory.agentId,
                    agentModelLoadMs: agentStart.modelLoadMs,
                    trial,
                    lifecycle,
                    reset,
                    timeoutMs,
                    e2eStarted,
                    recordedAt,
                  })
                );
              } catch (error) {
                receipts.push(
                  createHarnessFailureReceipt({
                    task,
                    adapterId,
                    trial,
                    lifecycle,
                    corpusFingerprint: preparation.corpusFingerprint,
                    configFingerprint: owner.configFingerprint,
                    capabilities: owner.capabilities,
                    indexFingerprint: preparation.indexFingerprint,
                    toolsFingerprint: canonicalToolsFingerprint,
                    recordedAt,
                    code: "cold_trial_setup_failed",
                    error,
                  })
                );
              } finally {
                if (agentStart) {
                  const activeAgentStart = agentStart;
                  await disposeWithin(
                    () => activeAgentStart.runtime.dispose(),
                    timeoutMs
                  );
                }
                if (adapter) {
                  const activeAdapter = adapter;
                  await disposeWithin(() => activeAdapter.dispose(), timeoutMs);
                }
              }
            }
          }
        } else {
          let adapter: AgentAdapter | null = null;
          let agentStart: Awaited<
            ReturnType<OuterAgentFactory["open"]>
          > | null = null;
          let tools: readonly AgentToolDefinition[] = CANONICAL_AGENT_TOOLS;
          const pairs = trials.flatMap((trial) =>
            tasks.map((task) => ({ trial, task }))
          );
          const pushRemainingFailures = (
            start: number,
            error: unknown,
            code: string
          ): void => {
            for (const { task, trial } of pairs.slice(start)) {
              receipts.push(
                createHarnessFailureReceipt({
                  task,
                  adapterId,
                  trial,
                  lifecycle,
                  corpusFingerprint: preparation.corpusFingerprint,
                  configFingerprint: owner.configFingerprint,
                  capabilities: owner.capabilities,
                  indexFingerprint: preparation.indexFingerprint,
                  toolsFingerprint: canonicalToolsFingerprint,
                  recordedAt,
                  code,
                  error,
                })
              );
            }
          };
          try {
            adapter = await attachPreparedAdapter(
              factory,
              fixture,
              preparation,
              timeoutMs,
              expectedAdapter
            );
            tools = await listToolsWithin(adapter, timeoutMs);
            if (fingerprintTools(tools) !== canonicalToolsFingerprint) {
              throw new AgenticHarnessError(
                "tool_schema_mismatch",
                "Attached adapter changed the canonical tool schemas"
              );
            }
            agentStart = await withAbortTimeout(
              (signal) => agentFactory.open(signal),
              timeoutMs,
              new AgenticHarnessError(
                "agent_preflight_timeout",
                "Warm outer agent preflight timed out"
              )
            );
            validateAgentRuntimeStart(agentStart, agentFactory.agentId);
            const readiness = await withAbortTimeout(
              (signal) =>
                adapter?.reset({
                  task: tasks[0] as Readonly<AgentTask>,
                  lifecycle,
                  readinessProbe: true,
                  signal,
                }) as Promise<AdapterResetResult>,
              timeoutMs,
              new AgenticHarnessError(
                "readiness_probe_timeout",
                "Warm readiness probe timed out"
              )
            );
            validateAdapterResetResult(readiness);
            for (const [index, { trial, task }] of pairs.entries()) {
              try {
                const reset = await withAbortTimeout(
                  (signal) =>
                    adapter?.reset({
                      task,
                      lifecycle,
                      readinessProbe: false,
                      signal,
                    }) as Promise<AdapterResetResult>,
                  timeoutMs,
                  new AgenticHarnessError(
                    "adapter_reset_timeout",
                    "Warm adapter reset timed out"
                  )
                );
                validateAdapterResetResult(reset);
                const e2eStarted = performance.now();
                const receipt = await runAgentTrial({
                  task,
                  adapter,
                  preparation,
                  tools,
                  agentRuntime: agentStart.runtime,
                  expectedAgentId: agentFactory.agentId,
                  agentModelLoadMs: agentStart.modelLoadMs,
                  trial,
                  lifecycle,
                  reset,
                  timeoutMs,
                  e2eStarted,
                  recordedAt,
                });
                receipts.push(receipt);
                if (
                  receipt.canonical.failure.code &&
                  WARM_STATE_UNKNOWN_CODES.has(receipt.canonical.failure.code)
                ) {
                  pushRemainingFailures(
                    index + 1,
                    new Error(
                      "Warm adapter state may be contaminated after a failed trial"
                    ),
                    "warm_cohort_corrupted"
                  );
                  break;
                }
              } catch (error) {
                pushRemainingFailures(index, error, "warm_cohort_corrupted");
                break;
              }
            }
          } catch (error) {
            pushRemainingFailures(0, error, "warm_cohort_setup_failed");
          } finally {
            if (agentStart) {
              const activeAgentStart = agentStart;
              await disposeWithin(
                () => activeAgentStart.runtime.dispose(),
                timeoutMs
              );
            }
            if (adapter) {
              const activeAdapter = adapter;
              await disposeWithin(() => activeAdapter.dispose(), timeoutMs);
            }
          }
        }
      }
    } finally {
      await disposeWithin(() => owner.dispose(), timeoutMs);
    }
  }

  return {
    receipts,
    preparations,
    canonicalFingerprint: canonicalFingerprint(
      receipts.map((receipt) => receipt.canonical)
    ),
  };
};
