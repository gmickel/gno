import type {
  AgentTask,
  EvidenceCoordinate,
  FinalEnvelope,
  HiddenOracle,
  TrajectoryReceipt,
} from "../../../evals/agentic/types";

import {
  modelVisibleUtf8Bytes,
  projectModelVisibleToolResult,
} from "../../../evals/agentic/canonical";

const ZERO_HASH = "0".repeat(64);

export const evidence = (
  overrides: Partial<EvidenceCoordinate> = {}
): EvidenceCoordinate => ({
  uri: "gno://c001/d001.md",
  sourceHash: ZERO_HASH,
  startLine: 2,
  endLine: 2,
  spanHash: ZERO_HASH,
  sourceHashProvenance: "harness_observed",
  spanHashProvenance: "harness_observed",
  ...overrides,
});

export const taskFixture = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  schemaVersion: "1.0",
  taskId: "t0a1b2c3",
  category: "exact_identifier",
  brief: { goal: "Find the incident ID.", instructions: ["Cite evidence."] },
  claims: [
    {
      claimKey: "incidentId",
      valueType: "identifier",
      substantive: true,
      required: true,
    },
  ],
  allowedTools: ["search", "get"],
  budgets: { maxAgentCalls: 3, maxModelVisibleBytes: 1000 },
  corpus: { collections: ["c001"] },
  ...overrides,
});

export const oracleFixture = (
  coordinate = evidence(),
  overrides: Partial<HiddenOracle> = {}
): HiddenOracle => ({
  schemaVersion: "1.0",
  taskId: "t0a1b2c3",
  claims: [
    {
      claimKey: "incidentId",
      expectedValue: { type: "identifier", value: "INC-4827" },
      normalizer: { id: "identifier-v1", version: 1 },
      requiredEvidence: [coordinate],
      optionalEvidence: [],
      forbiddenEvidence: [],
    },
  ],
  expectedMissing: [],
  expectedScope: { collection: "c001", filters: {} },
  completion: {
    expectAbstention: false,
    maxAgentCalls: 3,
    maxModelVisibleBytes: 1000,
    failOnUnexpectedEvidence: false,
  },
  leakCanaries: ["oracle-only-test-canary"],
  ...overrides,
});

export const finalEnvelopeFixture = (
  coordinate = evidence(),
  overrides: Partial<FinalEnvelope> = {}
): FinalEnvelope => ({
  schemaVersion: "1.0",
  claims: [
    {
      claimKey: "incidentId",
      value: { type: "identifier", value: "INC-4827" },
      citations: [coordinate],
    },
  ],
  gaps: [],
  abstained: false,
  stopReason: "complete",
  ...overrides,
});

export const receiptFixture = (
  coordinate = evidence(),
  overrides: Partial<TrajectoryReceipt["canonical"]> = {}
): TrajectoryReceipt => {
  const finalEnvelope = finalEnvelopeFixture(coordinate);
  const toolResult = {
    status: "ok" as const,
    resultRole: "source" as const,
    content: "Incident identifier: INC-4827",
    evidence: [
      {
        ...coordinate,
        text: "Incident identifier: INC-4827",
        backendSourceHash: null,
        backendSpanHash: null,
        backendHashUnavailableReason: "adapter did not expose hashes",
      },
    ],
    errorCode: null,
  };
  const visibleBytes = modelVisibleUtf8Bytes(
    projectModelVisibleToolResult(toolResult)
  );
  return {
    schemaVersion: "1.0",
    canonical: {
      schemaVersion: "1.0",
      taskId: "t0a1b2c3",
      adapterId: "fixture",
      trialId: "trial-1",
      seed: null,
      lifecycle: "cold",
      agentId: "fixture-agent@1",
      capabilities: {
        backendInvocationAccounting: true,
        startupTiming: true,
        modelLoadTiming: false,
        toolTiming: true,
        tools: {
          search: "supported",
          get: "supported",
          multi_get: "supported",
        },
        exactLineSpans: "supported",
        measuredTokens: "unavailable",
        backendHashes: "unavailable",
        lifecycle: { cold: "supported", warm: "supported" },
      },
      calls: [
        {
          callIndex: 0,
          toolName: "search",
          arguments: { query: "incident", collection: "c001" },
          result: toolResult,
          deliveredToAgent: true,
          failureCode: null,
          modelVisibleUtf8Bytes: visibleBytes,
          measuredTokens: null,
          tokenizerFingerprint: null,
          backendInvocations: 1,
        },
      ],
      agentCalls: 1,
      backendInvocations: 1,
      modelVisibleUtf8Bytes: visibleBytes,
      measuredTokens: null,
      finalEnvelope,
      stopReason: "complete",
      failure: { class: "none", code: null, redactedMessage: null },
      fingerprints: {
        corpus: ZERO_HASH,
        prompt: ZERO_HASH,
        tools: ZERO_HASH,
        model: ZERO_HASH,
        runtime: ZERO_HASH,
        config: ZERO_HASH,
        index: ZERO_HASH,
      },
      ...overrides,
    },
    observations: {
      recordedAt: "2026-07-22T12:00:00.000Z",
      timings: {
        preparation: { valueMs: 1, unavailableReason: null },
        startup: { valueMs: 2, unavailableReason: null },
        modelLoad: { valueMs: null, unavailableReason: "no model" },
        tool: { valueMs: 3, unavailableReason: null },
        driver: { valueMs: 4, unavailableReason: null },
        endToEnd: { valueMs: 9, unavailableReason: null },
      },
      process: { peakRssBytes: null, unavailableReason: "not sampled" },
      tempPaths: ["/tmp/volatile"],
      diagnostics: [],
    },
  };
};
