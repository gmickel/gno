import type {
  AgentAdapter,
  AdapterPreparation,
  AdapterResetResult,
  AgentToolDefinition,
} from "./adapter";
import type { AgentTrial, OuterAgentSession } from "./agent";
import type {
  AgentTask,
  CanonicalAgentCall,
  FailureClass,
  FinalEnvelope,
  TimingObservation,
  TrajectoryReceipt,
} from "./types";

import {
  AgenticAgentError,
  AgenticHarnessError,
  AgenticProductError,
  fingerprintTools,
  measuredTiming,
  unavailableTiming,
} from "./adapter";
import { canonicalFingerprint } from "./canonical";
import { assertAgenticSchema } from "./validation";

const ZERO_HASH = "0".repeat(64);

export interface TrialReceiptContext {
  task: Readonly<AgentTask>;
  adapter: AgentAdapter;
  preparation: AdapterPreparation;
  tools: readonly AgentToolDefinition[];
  agentModelLoadMs: number | null;
  trial: AgentTrial;
  lifecycle: "cold" | "warm";
  reset: AdapterResetResult;
  e2eStarted: number;
  recordedAt: () => string;
}

export interface FailureData {
  class: FailureClass;
  code: string;
  redactedMessage: string;
}

export const redactError = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(?:\/[\w.@+-]+){2,}/g, "<path>")
    .replace(/\\(?:[^\\\s]+\\)+[^\\\s]+/g, "<path>")
    .slice(0, 240);
};

export const classifyError = (error: unknown): FailureData => {
  if (error instanceof AgenticAgentError) {
    return {
      class: "agent_error",
      code: error.code,
      redactedMessage: redactError(error),
    };
  }
  if (error instanceof AgenticProductError) {
    return {
      class: "product_error",
      code: error.code,
      redactedMessage: redactError(error),
    };
  }
  if (error instanceof AgenticHarnessError) {
    return {
      class: "harness_error",
      code: error.code,
      redactedMessage: redactError(error),
    };
  }
  return {
    class: "harness_error",
    code: "unexpected_harness_error",
    redactedMessage: redactError(error),
  };
};

const addTimings = (
  timings: readonly TimingObservation[],
  unavailableReason: string
): TimingObservation => {
  if (timings.some((timing) => timing.valueMs === null)) {
    return unavailableTiming(unavailableReason);
  }
  return measuredTiming(
    timings.reduce((sum, timing) => sum + (timing.valueMs ?? 0), 0)
  );
};

const runtimeFingerprint = (): string =>
  canonicalFingerprint({
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    runner: "agentic-runner-v1",
  });

const totalTokens = (calls: readonly CanonicalAgentCall[]): number | null => {
  if (calls.length === 0 || calls.some((call) => call.measuredTokens === null))
    return null;
  return calls.reduce((sum, call) => sum + (call.measuredTokens ?? 0), 0);
};

export const createTrajectoryReceipt = (
  context: TrialReceiptContext,
  session: OuterAgentSession | null,
  calls: CanonicalAgentCall[],
  finalEnvelope: FinalEnvelope | null,
  failure: FailureData | null,
  driverMs: number,
  toolTimings: TimingObservation[],
  diagnostics: string[]
): TrajectoryReceipt => {
  const isWarm = context.lifecycle === "warm";
  const receipt: TrajectoryReceipt = {
    schemaVersion: "1.0",
    canonical: {
      schemaVersion: "1.0",
      taskId: context.task.taskId,
      adapterId: context.adapter.adapterId,
      trialId: context.trial.trialId,
      seed: context.trial.seed,
      lifecycle: context.lifecycle,
      agentId: session?.agentId ?? "unavailable",
      capabilities: structuredClone(context.adapter.capabilities),
      calls,
      agentCalls: calls.length,
      backendInvocations: calls.reduce(
        (sum, call) => sum + call.backendInvocations,
        0
      ),
      modelVisibleUtf8Bytes: calls.reduce(
        (sum, call) => sum + call.modelVisibleUtf8Bytes,
        0
      ),
      measuredTokens: totalTokens(calls),
      finalEnvelope,
      stopReason: finalEnvelope?.stopReason ?? "error",
      failure: failure
        ? {
            class: failure.class,
            code: failure.code,
            redactedMessage: null,
          }
        : { class: "none", code: null, redactedMessage: null },
      fingerprints: {
        corpus: context.preparation.corpusFingerprint,
        prompt: session?.promptFingerprint ?? ZERO_HASH,
        tools: fingerprintTools(context.tools),
        model: session?.modelFingerprint ?? ZERO_HASH,
        runtime: runtimeFingerprint(),
        config: context.adapter.configFingerprint,
        index: context.preparation.indexFingerprint,
      },
    },
    observations: {
      recordedAt: context.recordedAt(),
      timings: {
        preparation: context.preparation.preparation,
        startup: isWarm
          ? unavailableTiming("completed before scored warm cohort")
          : context.reset.startup,
        modelLoad: isWarm
          ? unavailableTiming("completed before scored warm cohort")
          : addTimings(
              [
                context.reset.modelLoad,
                context.agentModelLoadMs === null
                  ? unavailableTiming("outer agent has no model")
                  : measuredTiming(context.agentModelLoadMs),
              ],
              "one or more model-load components unavailable"
            ),
        tool: addTimings(toolTimings, "one or more tool timings unavailable"),
        driver: measuredTiming(driverMs),
        endToEnd: measuredTiming(performance.now() - context.e2eStarted),
      },
      process: {
        peakRssBytes: null,
        unavailableReason: "peak RSS not sampled",
      },
      tempPaths: [...context.preparation.tempPaths],
      diagnostics: [
        ...context.reset.diagnostics,
        ...diagnostics,
        ...(failure ? [failure.redactedMessage] : []),
      ],
    },
  };
  assertAgenticSchema("trajectory-receipt", receipt);
  return receipt;
};

export interface HarnessFailureReceiptInput {
  task: Readonly<AgentTask>;
  adapterId: string;
  trial: AgentTrial;
  lifecycle: "cold" | "warm";
  agentId: string;
  corpusFingerprint: string;
  configFingerprint: string;
  capabilities: AgentAdapter["capabilities"];
  indexFingerprint?: string;
  toolsFingerprint?: string;
  recordedAt: () => string;
  code: string;
  error: unknown;
}

export const createHarnessFailureReceipt = (
  input: HarnessFailureReceiptInput
): TrajectoryReceipt => {
  const message = redactError(input.error);
  const unavailable = unavailableTiming(
    "trial did not start because the harness failed"
  );
  const receipt: TrajectoryReceipt = {
    schemaVersion: "1.0",
    canonical: {
      schemaVersion: "1.0",
      taskId: input.task.taskId,
      adapterId: input.adapterId,
      trialId: input.trial.trialId,
      seed: input.trial.seed,
      lifecycle: input.lifecycle,
      agentId: input.agentId,
      capabilities: structuredClone(input.capabilities),
      calls: [],
      agentCalls: 0,
      backendInvocations: 0,
      modelVisibleUtf8Bytes: 0,
      measuredTokens: null,
      finalEnvelope: null,
      stopReason: "error",
      failure: {
        class: "harness_error",
        code: input.code,
        redactedMessage: null,
      },
      fingerprints: {
        corpus: input.corpusFingerprint,
        prompt: ZERO_HASH,
        tools: input.toolsFingerprint ?? ZERO_HASH,
        model: ZERO_HASH,
        runtime: runtimeFingerprint(),
        config: input.configFingerprint,
        index: input.indexFingerprint ?? ZERO_HASH,
      },
    },
    observations: {
      recordedAt: input.recordedAt(),
      timings: {
        preparation: unavailable,
        startup: unavailable,
        modelLoad: unavailable,
        tool: unavailable,
        driver: unavailable,
        endToEnd: unavailable,
      },
      process: {
        peakRssBytes: null,
        unavailableReason: "peak RSS not sampled",
      },
      tempPaths: [],
      diagnostics: [message],
    },
  };
  assertAgenticSchema("trajectory-receipt", receipt);
  return receipt;
};
