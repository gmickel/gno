import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import type { ContextCapsuleDemoArtifact } from "./demos/context-capsule-types";
import type {
  AgentTask,
  BenchmarkReport,
  FinalEnvelope,
  HiddenOracle,
  TrajectoryReceipt,
} from "./types";

import {
  modelVisibleUtf8Bytes,
  projectModelVisibleToolResult,
} from "./canonical";
import agentTaskSchema from "./schemas/agent-task.schema.json";
import benchmarkReportSchema from "./schemas/benchmark-report.schema.json";
import contextCapsuleDemoSchema from "./schemas/context-capsule-demo.schema.json";
import finalEnvelopeSchema from "./schemas/final-envelope.schema.json";
import hiddenOracleSchema from "./schemas/hidden-oracle.schema.json";
import trajectoryReceiptSchema from "./schemas/trajectory-receipt.schema.json";

export interface AgenticSchemaTypes {
  "agent-task": AgentTask;
  "benchmark-report": BenchmarkReport;
  "context-capsule-demo": ContextCapsuleDemoArtifact;
  "final-envelope": FinalEnvelope;
  "hidden-oracle": HiddenOracle;
  "trajectory-receipt": TrajectoryReceipt;
}

const schemas = {
  "agent-task": agentTaskSchema,
  "benchmark-report": benchmarkReportSchema,
  "context-capsule-demo": contextCapsuleDemoSchema,
  "final-envelope": finalEnvelopeSchema,
  "hidden-oracle": hiddenOracleSchema,
  "trajectory-receipt": trajectoryReceiptSchema,
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of Object.values(schemas)) {
  ajv.addSchema(schema);
}

const validators = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [
    name,
    ajv.getSchema(schema.$id) ?? ajv.compile(schema),
  ])
) as Record<keyof AgenticSchemaTypes, ValidateFunction>;

const formatErrors = (errors: ErrorObject[] | null | undefined): string =>
  (errors ?? [])
    .map((error) => {
      const path = error.instancePath || "/";
      return `${path} ${error.keyword} ${error.message ?? "invalid"}`;
    })
    .sort()
    .join("; ");

export const validateAgenticSchema = <K extends keyof AgenticSchemaTypes>(
  name: K,
  value: unknown
): value is AgenticSchemaTypes[K] => validators[name](value) as boolean;

export function assertAgenticSchema<K extends keyof AgenticSchemaTypes>(
  name: K,
  value: unknown
): asserts value is AgenticSchemaTypes[K] {
  const validate = validators[name];
  if (!validate(value)) {
    throw new Error(
      `${name} schema validation failed: ${formatErrors(validate.errors)}`
    );
  }
}

export const listAgenticSchemas = (): Array<keyof AgenticSchemaTypes> =>
  Object.keys(schemas).sort() as Array<keyof AgenticSchemaTypes>;

export const projectAgentVisibleTask = (
  task: AgentTask
): Readonly<AgentTask> => {
  assertAgenticSchema("agent-task", task);
  const cloned = structuredClone(task);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(cloned);
  return cloned;
};

export interface FinalEnvelopeSemanticIssue {
  code:
    | "duplicate_claim"
    | "duplicate_gap"
    | "extra_claim"
    | "extra_gap"
    | "missing_required_claim"
    | "type_mismatch"
    | "uncited_required_claim"
    | "invalid_evidence_range";
  claimKey: string;
}

export const validateFinalEnvelopeSemantics = (
  task: AgentTask,
  envelope: FinalEnvelope
): FinalEnvelopeSemanticIssue[] => {
  const issues: FinalEnvelopeSemanticIssue[] = [];
  const definitions = new Map(
    task.claims.map((claim) => [claim.claimKey, claim])
  );
  const claimKeys = new Set<string>();
  for (const claim of envelope.claims) {
    if (claimKeys.has(claim.claimKey)) {
      issues.push({ code: "duplicate_claim", claimKey: claim.claimKey });
    }
    claimKeys.add(claim.claimKey);
    const definition = definitions.get(claim.claimKey);
    if (!definition) {
      issues.push({ code: "extra_claim", claimKey: claim.claimKey });
      continue;
    }
    if (claim.value.type !== definition.valueType) {
      issues.push({ code: "type_mismatch", claimKey: claim.claimKey });
    }
    if (definition.required && claim.citations.length === 0) {
      issues.push({ code: "uncited_required_claim", claimKey: claim.claimKey });
    }
    if (
      claim.citations.some((citation) => citation.endLine < citation.startLine)
    ) {
      issues.push({
        code: "invalid_evidence_range",
        claimKey: claim.claimKey,
      });
    }
  }
  const gapKeys = new Set<string>();
  for (const gap of envelope.gaps) {
    if (gapKeys.has(gap.claimKey)) {
      issues.push({ code: "duplicate_gap", claimKey: gap.claimKey });
    }
    gapKeys.add(gap.claimKey);
    if (!definitions.has(gap.claimKey)) {
      issues.push({ code: "extra_gap", claimKey: gap.claimKey });
    }
  }
  for (const definition of task.claims) {
    if (
      definition.required &&
      !claimKeys.has(definition.claimKey) &&
      !gapKeys.has(definition.claimKey)
    ) {
      issues.push({
        code: "missing_required_claim",
        claimKey: definition.claimKey,
      });
    }
  }
  return issues;
};

export const validateTrajectoryAccounting = (
  receipt: TrajectoryReceipt
): string[] => {
  const issues: string[] = [];
  const { canonical } = receipt;
  if (canonical.agentCalls !== canonical.calls.length) {
    issues.push("agent_calls_mismatch");
  }
  if (canonical.calls.some((call, index) => call.callIndex !== index)) {
    issues.push("call_index_sequence_invalid");
  }
  const backendInvocations = canonical.calls.reduce(
    (sum, call) => sum + call.backendInvocations,
    0
  );
  if (canonical.backendInvocations !== backendInvocations) {
    issues.push("backend_invocations_mismatch");
  }
  const totalModelVisibleUtf8Bytes = canonical.calls.reduce(
    (sum, call) => sum + call.modelVisibleUtf8Bytes,
    0
  );
  if (canonical.modelVisibleUtf8Bytes !== totalModelVisibleUtf8Bytes) {
    issues.push("model_visible_bytes_mismatch");
  }
  if (
    canonical.calls.some(
      (call) =>
        call.modelVisibleUtf8Bytes !==
        (call.deliveredToAgent
          ? modelVisibleUtf8Bytes(projectModelVisibleToolResult(call.result))
          : 0)
    )
  ) {
    issues.push("call_model_visible_bytes_mismatch");
  }
  if (
    canonical.calls.some(
      (call) =>
        (call.deliveredToAgent && call.failureCode !== null) ||
        (!call.deliveredToAgent &&
          (typeof call.failureCode !== "string" ||
            !call.failureCode.trim() ||
            call.measuredTokens !== null ||
            call.tokenizerFingerprint !== null))
    )
  ) {
    issues.push("call_delivery_failure_invariant");
  }
  const undeliveredCalls = canonical.calls.filter(
    (call) => !call.deliveredToAgent
  );
  if (
    undeliveredCalls.length > 1 ||
    (undeliveredCalls.length === 1 &&
      canonical.calls.at(-1) !== undeliveredCalls[0]) ||
    (undeliveredCalls.length === 1 &&
      (canonical.failure.class === "none" ||
        canonical.failure.code !== undeliveredCalls[0]?.failureCode))
  ) {
    issues.push("undelivered_call_failure_mismatch");
  }
  const deliveredCalls = canonical.calls.filter(
    (call) => call.deliveredToAgent
  );
  const measuredTokens = deliveredCalls.map((call) => call.measuredTokens);
  const allTokensMeasured = measuredTokens.every(
    (tokens): tokens is number => tokens !== null
  );
  if (
    (deliveredCalls.length === 0 && canonical.measuredTokens !== null) ||
    (canonical.measuredTokens !== null && !allTokensMeasured) ||
    (deliveredCalls.length > 0 &&
      allTokensMeasured &&
      canonical.measuredTokens === null) ||
    (canonical.measuredTokens !== null &&
      canonical.measuredTokens !==
        measuredTokens.reduce<number>((sum, tokens) => sum + (tokens ?? 0), 0))
  ) {
    issues.push("measured_tokens_mismatch");
  }
  if (
    canonical.calls.some(
      (call) =>
        call.measuredTokens !== null && call.tokenizerFingerprint === null
    )
  ) {
    issues.push("tokenizer_fingerprint_missing");
  }
  if (
    canonical.calls.some(
      (call) =>
        call.measuredTokens === null && call.tokenizerFingerprint !== null
    )
  ) {
    issues.push("unexpected_tokenizer_fingerprint");
  }
  const tokenizerFingerprints = new Set(
    canonical.calls
      .map((call) => call.tokenizerFingerprint)
      .filter((value): value is string => value !== null)
  );
  if (tokenizerFingerprints.size > 1) {
    issues.push("tokenizer_fingerprint_mismatch");
  }
  if (
    canonical.finalEnvelope &&
    canonical.finalEnvelope.stopReason !== canonical.stopReason
  ) {
    issues.push("stop_reason_mismatch");
  }
  if (
    (canonical.failure.class === "none" &&
      (canonical.failure.code !== null ||
        canonical.failure.redactedMessage !== null)) ||
    (canonical.failure.class !== "none" && canonical.failure.code === null)
  ) {
    issues.push("failure_payload_invariant_invalid");
  }
  if (
    (canonical.finalEnvelope === null &&
      (canonical.stopReason !== "error" ||
        canonical.failure.class === "none")) ||
    (canonical.finalEnvelope !== null && canonical.failure.class !== "none")
  ) {
    issues.push("failure_envelope_invariant_invalid");
  }
  return issues;
};
