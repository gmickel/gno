import type {
  AdapterPreparation,
  AdapterResetResult,
  AgentAdapter,
  AgentToolDefinition,
} from "./adapter";
import type { AgentTrial, OuterAgentRuntime, OuterAgentSession } from "./agent";
import type {
  AgentTask,
  CanonicalAgentCall,
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
        throw new AgenticAgentError(
          "agent_call_budget_exceeded",
          "Agent call budget exceeded"
        );
      }
      let outcome;
      try {
        outcome = await withAbortTimeout(
          (signal) =>
            context.adapter.callTool(step.toolName, step.arguments, signal),
          context.timeoutMs,
          new AgenticProductError(
            "tool_timeout",
            `Tool timed out: ${step.toolName}`
          )
        );
      } catch (error) {
        if (
          error instanceof AgenticHarnessError ||
          error instanceof AgenticProductError
        ) {
          throw error;
        }
        throw new AgenticProductError(
          "tool_call_failed",
          `Adapter tool call failed: ${redactError(error)}`,
          { cause: error }
        );
      }
      validateAdapterToolCallResult(outcome);
      const visiblePayload = projectModelVisibleToolResult(outcome.result);
      const visibleJson = canonicalJson(visiblePayload);
      const visibleBytes = modelVisibleUtf8Bytes(visiblePayload);
      const accumulatedBytes = calls.reduce(
        (sum, call) => sum + call.modelVisibleUtf8Bytes,
        visibleBytes
      );
      if (accumulatedBytes > context.task.budgets.maxModelVisibleBytes) {
        throw new AgenticAgentError(
          "context_byte_budget_exceeded",
          "Model-visible byte budget exceeded"
        );
      }
      let measuredTokens: number | null;
      try {
        measuredTokens = session.countTokens(visibleJson);
      } catch (error) {
        throw new AgenticHarnessError(
          "invalid_token_accounting",
          "Outer agent token measurement failed",
          { cause: error }
        );
      }
      if (
        !(
          measuredTokens === null ||
          (Number.isSafeInteger(measuredTokens) && measuredTokens >= 0)
        ) ||
        (measuredTokens !== null && session.tokenizerFingerprint === null)
      ) {
        throw new AgenticHarnessError(
          "invalid_token_accounting",
          "Outer agent token measurement differs from the contract"
        );
      }
      calls.push({
        callIndex: calls.length,
        toolName: step.toolName,
        arguments: structuredClone(step.arguments),
        result: structuredClone(outcome.result),
        modelVisibleUtf8Bytes: visibleBytes,
        measuredTokens,
        tokenizerFingerprint:
          measuredTokens === null ? null : session.tokenizerFingerprint,
        backendInvocations: outcome.backendInvocations,
      });
      toolTimings.push(outcome.timing);
      diagnostics.push(...outcome.diagnostics);
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
