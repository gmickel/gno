import Ajv, { type ValidateFunction } from "ajv";

import type {
  AdapterResetResult,
  AdapterToolCallResult,
  AgentToolDefinition,
} from "./adapter";
import type {
  AgentRuntimeStart,
  AgentStep,
  AgentTrial,
  OuterAgentSession,
} from "./agent";
import type { AgentTask, NormalizedToolResult } from "./types";

import { AgenticAgentError, AgenticHarnessError } from "./adapter";
import { sha256Bytes } from "./canonical";
import {
  assertAgenticSchema,
  validateFinalEnvelopeSemantics,
} from "./validation";

const ajv = new Ajv({ allErrors: true, strict: true });
const toolArgumentValidators = new Map<string, ValidateFunction>();
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const validateRunMatrix = (input: {
  adapterIds: readonly string[];
  lifecycles: readonly unknown[];
  trials: readonly AgentTrial[];
  timeoutMs: number;
}): void => {
  const { adapterIds, lifecycles, trials, timeoutMs } = input;
  const trialIds = trials.map((trial) =>
    trial && typeof trial === "object" ? trial.trialId : null
  );
  if (
    adapterIds.length === 0 ||
    new Set(adapterIds).size !== adapterIds.length ||
    adapterIds.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new AgenticHarnessError(
      "invalid_adapter_schedule",
      "Adapter schedule must be nonempty, named, and unique"
    );
  }
  if (
    lifecycles.length === 0 ||
    new Set(lifecycles).size !== lifecycles.length ||
    lifecycles.some((value) => value !== "cold" && value !== "warm")
  ) {
    throw new AgenticHarnessError(
      "invalid_lifecycle_schedule",
      "Lifecycle schedule must be nonempty, valid, and unique"
    );
  }
  if (
    trials.length === 0 ||
    new Set(trialIds).size !== trialIds.length ||
    trials.some(
      (trial) =>
        !trial ||
        typeof trial !== "object" ||
        typeof trial.trialId !== "string" ||
        !trial.trialId.trim() ||
        !Number.isSafeInteger(trial.seed)
    )
  ) {
    throw new AgenticHarnessError(
      "invalid_trial_schedule",
      "Trial schedule must be nonempty with unique IDs and integer seeds"
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AgenticHarnessError(
      "invalid_runner_timeout",
      "Runner timeout must be a positive finite number"
    );
  }
};

const validateTiming = (value: unknown): boolean => {
  const timing = asRecord(value);
  if (!timing || !exactKeys(timing, ["valueMs", "unavailableReason"]))
    return false;
  return (
    (typeof timing.valueMs === "number" &&
      Number.isFinite(timing.valueMs) &&
      timing.valueMs >= 0 &&
      timing.unavailableReason === null) ||
    (timing.valueMs === null &&
      typeof timing.unavailableReason === "string" &&
      timing.unavailableReason.trim().length > 0)
  );
};

export const validateNormalizedToolResult = (
  result: NormalizedToolResult
): void => {
  const record = asRecord(result);
  if (
    !record ||
    !exactKeys(record, [
      "status",
      "resultRole",
      "content",
      "evidence",
      "errorCode",
    ]) ||
    (record.status !== "ok" && record.status !== "error") ||
    !["candidates", "source", "evidence_bundle"].includes(
      record.resultRole as string
    ) ||
    typeof record.content !== "string" ||
    !Array.isArray(record.evidence) ||
    (record.errorCode !== null && typeof record.errorCode !== "string") ||
    (result.status === "ok" && result.errorCode !== null) ||
    (result.status === "error" && !result.errorCode)
  ) {
    throw new AgenticHarnessError(
      "invalid_tool_result",
      "Normalized tool result differs from the closed contract"
    );
  }
  for (const item of result.evidence) {
    const evidence = asRecord(item);
    if (
      !evidence ||
      !exactKeys(evidence, [
        "uri",
        "sourceHash",
        "startLine",
        "endLine",
        "spanHash",
        "sourceHashProvenance",
        "spanHashProvenance",
        "text",
        "backendSourceHash",
        "backendSpanHash",
        "backendHashUnavailableReason",
      ]) ||
      typeof item.uri !== "string" ||
      !item.uri.startsWith("gno://") ||
      !Number.isInteger(item.startLine) ||
      !Number.isInteger(item.endLine) ||
      item.startLine < 1 ||
      item.endLine < item.startLine ||
      typeof item.text !== "string" ||
      typeof item.sourceHash !== "string" ||
      !SHA256_PATTERN.test(item.sourceHash) ||
      typeof item.spanHash !== "string" ||
      !SHA256_PATTERN.test(item.spanHash) ||
      !["harness_observed", "backend_provided"].includes(
        item.sourceHashProvenance
      ) ||
      !["harness_observed", "backend_provided"].includes(
        item.spanHashProvenance
      ) ||
      (item.backendSourceHash !== null &&
        (typeof item.backendSourceHash !== "string" ||
          !SHA256_PATTERN.test(item.backendSourceHash))) ||
      (item.backendSpanHash !== null &&
        (typeof item.backendSpanHash !== "string" ||
          !SHA256_PATTERN.test(item.backendSpanHash))) ||
      (item.backendHashUnavailableReason !== null &&
        (typeof item.backendHashUnavailableReason !== "string" ||
          !item.backendHashUnavailableReason.trim()))
    ) {
      throw new AgenticHarnessError(
        "invalid_tool_result",
        "Normalized evidence differs from the closed contract"
      );
    }
    if (sha256Bytes(item.text) !== item.spanHash) {
      throw new AgenticHarnessError(
        "invalid_tool_result",
        "Evidence text does not match its observed span hash"
      );
    }
    const hasBackendSourceHash = item.backendSourceHash !== null;
    const hasBackendSpanHash = item.backendSpanHash !== null;
    const hasCompleteBackendHashes = hasBackendSourceHash && hasBackendSpanHash;
    if (
      hasBackendSourceHash !== hasBackendSpanHash ||
      hasCompleteBackendHashes === (item.backendHashUnavailableReason !== null)
    ) {
      throw new AgenticHarnessError(
        "invalid_tool_result",
        "Backend hash availability invariant failed"
      );
    }
  }
};

export const validateAdapterToolCallResult = (
  outcome: AdapterToolCallResult
): void => {
  const record = asRecord(outcome);
  if (
    !record ||
    !exactKeys(record, [
      "result",
      "backendInvocations",
      "timing",
      "diagnostics",
    ]) ||
    !Number.isInteger(outcome.backendInvocations) ||
    outcome.backendInvocations < 0 ||
    !validateTiming(outcome.timing) ||
    !Array.isArray(outcome.diagnostics) ||
    !outcome.diagnostics.every((item) => typeof item === "string")
  ) {
    throw new AgenticHarnessError(
      "invalid_tool_result",
      "Adapter tool outcome differs from the closed contract"
    );
  }
  validateNormalizedToolResult(outcome.result);
};

export const validateAdapterResetResult = (value: AdapterResetResult): void => {
  const reset = asRecord(value);
  if (
    !reset ||
    !exactKeys(reset, ["startup", "modelLoad", "diagnostics"]) ||
    !validateTiming(value.startup) ||
    !validateTiming(value.modelLoad) ||
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every((item) => typeof item === "string")
  ) {
    throw new AgenticHarnessError(
      "invalid_adapter_reset",
      "Adapter reset result differs from the closed contract"
    );
  }
};

export const validateAgentRuntimeStart = (
  value: AgentRuntimeStart,
  expectedAgentId: string
): void => {
  const start = asRecord(value);
  const runtime = asRecord(value?.runtime);
  if (
    !expectedAgentId.trim() ||
    !start ||
    !exactKeys(start, ["runtime", "modelLoadMs"]) ||
    !runtime ||
    typeof value.runtime.createSession !== "function" ||
    typeof value.runtime.dispose !== "function" ||
    !(
      value.modelLoadMs === null ||
      (typeof value.modelLoadMs === "number" &&
        Number.isFinite(value.modelLoadMs) &&
        value.modelLoadMs >= 0)
    )
  ) {
    throw new AgenticHarnessError(
      "invalid_agent_runtime",
      "Outer agent runtime differs from the closed contract"
    );
  }
};

export const validateOuterAgentSession = (
  value: OuterAgentSession,
  expectedAgentId: string
): void => {
  const session = asRecord(value);
  if (
    !session ||
    value.agentId !== expectedAgentId ||
    typeof value.promptFingerprint !== "string" ||
    !SHA256_PATTERN.test(value.promptFingerprint) ||
    typeof value.modelFingerprint !== "string" ||
    !SHA256_PATTERN.test(value.modelFingerprint) ||
    !(
      value.tokenizerFingerprint === null ||
      (typeof value.tokenizerFingerprint === "string" &&
        SHA256_PATTERN.test(value.tokenizerFingerprint))
    ) ||
    typeof value.next !== "function" ||
    typeof value.countTokens !== "function" ||
    typeof value.dispose !== "function"
  ) {
    throw new AgenticHarnessError(
      "invalid_agent_session",
      "Outer agent session identity or runtime shape is invalid"
    );
  }
};

export const validateAgentStep = (
  value: unknown,
  task: Readonly<AgentTask>,
  tools: readonly AgentToolDefinition[]
): AgentStep => {
  const step = asRecord(value);
  if (!step || (step.kind !== "tool" && step.kind !== "final")) {
    throw new AgenticAgentError(
      "invalid_agent_step",
      "Outer agent returned an invalid step"
    );
  }
  if (step.kind === "final") {
    if (!exactKeys(step, ["kind", "envelope"])) {
      throw new AgenticAgentError(
        "invalid_final_envelope",
        "Final step fields differ from contract"
      );
    }
    try {
      assertAgenticSchema("final-envelope", step.envelope);
    } catch (error) {
      throw new AgenticAgentError(
        "invalid_final_envelope",
        "Final envelope schema is invalid",
        { cause: error }
      );
    }
    if (validateFinalEnvelopeSemantics(task, step.envelope).length > 0) {
      throw new AgenticAgentError(
        "invalid_final_envelope",
        "Final envelope semantics are invalid"
      );
    }
    return step as unknown as AgentStep;
  }
  if (
    !exactKeys(step, ["kind", "toolName", "arguments"]) ||
    typeof step.toolName !== "string" ||
    !asRecord(step.arguments)
  ) {
    throw new AgenticAgentError(
      "invalid_agent_action",
      "Tool action fields are invalid"
    );
  }
  const tool = tools.find((candidate) => candidate.name === step.toolName);
  if (!tool || !task.allowedTools.includes(step.toolName)) {
    throw new AgenticAgentError(
      "disallowed_tool",
      `Tool is not allowed: ${step.toolName}`
    );
  }
  let validator = toolArgumentValidators.get(tool.name);
  if (!validator) {
    validator = ajv.compile(tool.inputSchema);
    toolArgumentValidators.set(tool.name, validator);
  }
  if (!validator(step.arguments)) {
    throw new AgenticAgentError(
      "invalid_agent_action",
      `Tool arguments are invalid: ${step.toolName}`
    );
  }
  return step as unknown as AgentStep;
};
