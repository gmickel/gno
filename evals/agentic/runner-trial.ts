import type {
  AdapterPreparation,
  AdapterResetResult,
  AgentAdapter,
  AgentToolDefinition,
  AdapterToolCallResult,
} from "./adapter";
import type { AgentTrial, OuterAgentRuntime, OuterAgentSession } from "./agent";
import type {
  AgentTask,
  CanonicalAgentCall,
  NormalizedToolResult,
  TimingObservation,
  TrajectoryReceipt,
} from "./types";

import {
  AgenticAgentError,
  AgenticHarnessError,
  AgenticProductError,
} from "./adapter";
import {
  canonicalJson,
  modelVisibleUtf8Bytes,
  projectAgentVisibleCalls,
  projectModelVisibleToolResult,
} from "./canonical";
import { disposeWithin, withAbortTimeout } from "./runner-contract";
import {
  classifyError,
  createTrajectoryReceipt,
  redactError,
} from "./runner-receipt";
import {
  validateAdapterToolCallResult,
  validateAgentStep,
  validateOuterAgentSession,
} from "./runner-validation";

export interface TrialContext {
  task: Readonly<AgentTask>;
  adapter: AgentAdapter;
  preparation: AdapterPreparation;
  tools: readonly AgentToolDefinition[];
  agentRuntime: OuterAgentRuntime;
  expectedAgentId: string;
  agentModelLoadMs: number | null;
  trial: AgentTrial;
  lifecycle: "cold" | "warm";
  reset: AdapterResetResult;
  timeoutMs: number;
  e2eStarted: number;
  recordedAt: () => string;
}

interface ValidToolChoice {
  toolName: string;
  arguments: Record<string, unknown>;
}

const failedToolResult = (
  toolName: string,
  failureCode: string
): NormalizedToolResult => ({
  status: "error",
  resultRole: toolName === "search" ? "candidates" : "source",
  content: "",
  evidence: [],
  errorCode: failureCode,
});

const knownBackendInvocations = (value: unknown): number => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const count = (value as { backendInvocations?: unknown }).backendInvocations;
  return Number.isSafeInteger(count) && (count as number) >= 0
    ? (count as number)
    : 0;
};

const normalizeToolFailure = (error: unknown): Error => {
  if (
    error instanceof AgenticHarnessError ||
    error instanceof AgenticProductError ||
    error instanceof AgenticAgentError
  ) {
    return error;
  }
  return new AgenticProductError(
    "tool_call_failed",
    `Adapter tool call failed: ${redactError(error)}`,
    { cause: error }
  );
};

const recordCall = (
  calls: CanonicalAgentCall[],
  step: ValidToolChoice,
  input: {
    result: NormalizedToolResult;
    deliveredToAgent: boolean;
    failureCode: string | null;
    modelVisibleUtf8Bytes: number;
    measuredTokens: number | null;
    tokenizerFingerprint: string | null;
    backendInvocations: number;
  }
): void => {
  calls.push({
    callIndex: calls.length,
    toolName: step.toolName,
    arguments: structuredClone(step.arguments),
    ...input,
    result: structuredClone(input.result),
  });
};

export const runAgentTrial = async (
  context: TrialContext
): Promise<TrajectoryReceipt> => {
  let session: OuterAgentSession | null = null;
  const calls: CanonicalAgentCall[] = [];
  const toolTimings: TimingObservation[] = [];
  const diagnostics: string[] = [];
  let driverMs = 0;
  try {
    const createdSession = await withAbortTimeout(
      (signal) =>
        context.agentRuntime.createSession(
          {
            task: context.task,
            tools: context.tools,
            trial: context.trial,
          },
          signal
        ),
      context.timeoutMs,
      new AgenticHarnessError(
        "agent_session_timeout",
        "Outer agent session creation timed out"
      )
    );
    validateOuterAgentSession(createdSession, context.expectedAgentId);
    session = createdSession;
    while (true) {
      const agentStarted = performance.now();
      const rawStep = await withAbortTimeout(
        (signal) =>
          session?.next(projectAgentVisibleCalls(calls), signal) as Promise<
            Awaited<ReturnType<OuterAgentSession["next"]>>
          >,
        context.timeoutMs,
        new AgenticAgentError("agent_timeout", "Outer agent step timed out")
      );
      driverMs += performance.now() - agentStarted;
      const step = validateAgentStep(rawStep, context.task, context.tools);
      if (step.kind === "final") {
        return createTrajectoryReceipt(
          context,
          session,
          calls,
          step.envelope,
          null,
          driverMs,
          toolTimings,
          diagnostics
        );
      }
      if (calls.length >= context.task.budgets.maxAgentCalls) {
        const failure = new AgenticAgentError(
          "agent_call_budget_exceeded",
          "Agent call budget exceeded"
        );
        recordCall(calls, step, {
          result: failedToolResult(step.toolName, failure.code),
          deliveredToAgent: false,
          failureCode: failure.code,
          modelVisibleUtf8Bytes: 0,
          measuredTokens: null,
          tokenizerFingerprint: null,
          backendInvocations: 0,
        });
        throw failure;
      }
      let rawOutcome: unknown;
      try {
        rawOutcome = await withAbortTimeout(
          (signal) =>
            context.adapter.callTool(step.toolName, step.arguments, signal),
          context.timeoutMs,
          new AgenticProductError(
            "tool_timeout",
            `Tool timed out: ${step.toolName}`
          )
        );
      } catch (error) {
        const failure = normalizeToolFailure(error);
        const failureCode = classifyError(failure).code;
        recordCall(calls, step, {
          result: failedToolResult(step.toolName, failureCode),
          deliveredToAgent: false,
          failureCode,
          modelVisibleUtf8Bytes: 0,
          measuredTokens: null,
          tokenizerFingerprint: null,
          backendInvocations: Math.max(
            knownBackendInvocations(error),
            knownBackendInvocations(rawOutcome)
          ),
        });
        throw failure;
      }
      try {
        validateAdapterToolCallResult(rawOutcome as AdapterToolCallResult);
      } catch (error) {
        const failure = normalizeToolFailure(error);
        const failureCode = classifyError(failure).code;
        recordCall(calls, step, {
          result: failedToolResult(step.toolName, failureCode),
          deliveredToAgent: false,
          failureCode,
          modelVisibleUtf8Bytes: 0,
          measuredTokens: null,
          tokenizerFingerprint: null,
          backendInvocations: knownBackendInvocations(rawOutcome),
        });
        throw failure;
      }
      const outcome = rawOutcome as AdapterToolCallResult;
      toolTimings.push(outcome.timing);
      diagnostics.push(...outcome.diagnostics);
      const visiblePayload = projectModelVisibleToolResult(outcome.result);
      const visibleJson = canonicalJson(visiblePayload);
      const visibleBytes = modelVisibleUtf8Bytes(visiblePayload);
      const accumulatedBytes = calls.reduce(
        (sum, call) => sum + call.modelVisibleUtf8Bytes,
        visibleBytes
      );
      if (accumulatedBytes > context.task.budgets.maxModelVisibleBytes) {
        const failure = new AgenticAgentError(
          "context_byte_budget_exceeded",
          "Model-visible byte budget exceeded"
        );
        recordCall(calls, step, {
          result: outcome.result,
          deliveredToAgent: false,
          failureCode: failure.code,
          modelVisibleUtf8Bytes: 0,
          measuredTokens: null,
          tokenizerFingerprint: null,
          backendInvocations: outcome.backendInvocations,
        });
        throw failure;
      }
      let measuredTokens: number | null;
      try {
        measuredTokens = session.countTokens(visibleJson);
      } catch (error) {
        const failure = new AgenticHarnessError(
          "invalid_token_accounting",
          "Outer agent token measurement failed",
          { cause: error }
        );
        recordCall(calls, step, {
          result: outcome.result,
          deliveredToAgent: false,
          failureCode: failure.code,
          modelVisibleUtf8Bytes: 0,
          measuredTokens: null,
          tokenizerFingerprint: null,
          backendInvocations: outcome.backendInvocations,
        });
        throw failure;
      }
      if (
        !(
          measuredTokens === null ||
          (Number.isSafeInteger(measuredTokens) && measuredTokens >= 0)
        ) ||
        (measuredTokens !== null && session.tokenizerFingerprint === null)
      ) {
        const failure = new AgenticHarnessError(
          "invalid_token_accounting",
          "Outer agent token measurement differs from the contract"
        );
        recordCall(calls, step, {
          result: outcome.result,
          deliveredToAgent: false,
          failureCode: failure.code,
          modelVisibleUtf8Bytes: 0,
          measuredTokens: null,
          tokenizerFingerprint: null,
          backendInvocations: outcome.backendInvocations,
        });
        throw failure;
      }
      recordCall(calls, step, {
        result: structuredClone(outcome.result),
        deliveredToAgent: true,
        failureCode: null,
        modelVisibleUtf8Bytes: visibleBytes,
        measuredTokens,
        tokenizerFingerprint:
          measuredTokens === null ? null : session.tokenizerFingerprint,
        backendInvocations: outcome.backendInvocations,
      });
    }
  } catch (error) {
    return createTrajectoryReceipt(
      context,
      session,
      calls,
      null,
      classifyError(error),
      driverMs,
      toolTimings,
      diagnostics
    );
  } finally {
    if (session) {
      const activeSession = session;
      await disposeWithin(() => activeSession.dispose(), context.timeoutMs);
    }
  }
};
