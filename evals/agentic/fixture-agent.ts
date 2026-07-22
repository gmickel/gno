import type {
  AgentCreateContext,
  AgentStep,
  OuterAgentFactory,
  OuterAgentRuntime,
  OuterAgentSession,
} from "./agent";
import type {
  AgentTask,
  AgentVisibleToolResult,
  ClaimValue,
  EvidenceCoordinate,
  FinalClaim,
  FinalEnvelope,
} from "./types";

import { AgenticAgentError } from "./adapter";
import {
  canonicalFingerprint,
  normalizeNewlines,
  sha256Bytes,
} from "./canonical";
import { parseStrictAgentJson } from "./strict-json";
import {
  assertAgenticSchema,
  validateFinalEnvelopeSemantics,
} from "./validation";

export const FIXTURE_AGENT_VERSION = "fixture-agent-v1" as const;

export const FIXTURE_AGENT_PROMPT = `You are a deterministic evidence agent.
Use only the visible task and normalized tool results. Search before reading.
Return one JSON FinalEnvelope and no prose. Every claim must use its declared
type and cite exact observed source lines. Emit an explicit gap and abstain when
required evidence is absent. Stop as soon as every required claim is supported.`;

const CUES: Readonly<Record<string, readonly string[]>> = {
  approvedBudget: ["budget"],
  automaticExport: ["exportación automática", "automatic export"],
  availabilityTarget: ["availability target"],
  bothIncludeAuditLogs: ["audit logs included"],
  configKey: ["configuration key"],
  defaultBatchSize: ["batchsize", "batch size"],
  dependency: ["depends on"],
  earliestMilestone: ["milestone date"],
  escalationWindow: ["escalation window"],
  errorIdentifier: ["failure identifier", "error identifier"],
  incidentId: ["incident identifier"],
  invoiceId: ["invoice identifier"],
  launchDate: ["launch date"],
  migrationOwner: ["owner", "ownership"],
  initiativeOwner: ["initiative owner"],
  ownerTeam: ["owned by"],
  projectCodename: ["project codename"],
  releaseCodename: ["发布代号"],
  renewalDate: ["date de renouvellement"],
  retentionComparison: ["log retention"],
  rolloutRegion: ["selected rollout region"],
  selectedDatabase: ["decision", "database"],
  serviceOwner: ["service owner"],
  supportCity: ["gewählter standort"],
};

const BOOLEAN_TRUE = /(?:\byes\b|\bsí\b|\btrue\b|activated|activada|enabled)/i;
const BOOLEAN_FALSE = /(?:\bno\b|\bfalse\b|not included|disabled)/i;
const DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/g;
const IDENTIFIER_PATTERN = /\b[A-Z][A-Z0-9]*(?:[-_.][A-Z0-9]+)+\b/g;
const NUMBER_PATTERN = /\b\d+(?:\.\d+)?\b/g;

interface EvidenceLine {
  evidence: AgentVisibleToolResult["evidence"][number];
  text: string;
  line: number;
}

const evidenceVisibleInBundleContent = (
  result: AgentVisibleToolResult
): AgentVisibleToolResult["evidence"] => {
  if (result.evidence.length > 0 || result.resultRole !== "evidence_bundle") {
    return result.evidence;
  }
  try {
    const payload = JSON.parse(result.content) as { evidence?: unknown };
    if (!Array.isArray(payload.evidence)) return [];
    return payload.evidence.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return [];
      const item = value as Record<string, unknown>;
      if (
        typeof item.uri !== "string" ||
        typeof item.sourceHash !== "string" ||
        typeof item.startLine !== "number" ||
        !Number.isInteger(item.startLine) ||
        typeof item.endLine !== "number" ||
        !Number.isInteger(item.endLine) ||
        typeof item.spanHash !== "string" ||
        typeof item.text !== "string"
      ) {
        return [];
      }
      return [
        {
          uri: item.uri,
          sourceHash: item.sourceHash,
          startLine: item.startLine,
          endLine: item.endLine,
          spanHash: item.spanHash,
          sourceHashProvenance: "backend_provided" as const,
          spanHashProvenance: "backend_provided" as const,
          text: item.text,
        },
      ];
    });
  } catch {
    return [];
  }
};

const evidenceLines = (
  evidence: readonly AgentVisibleToolResult["evidence"][number][]
): EvidenceLine[] =>
  evidence.flatMap((item) =>
    normalizeNewlines(item.text)
      .split("\n")
      .map((text, index) => ({
        evidence: item,
        text,
        line: item.startLine + index,
      }))
  );

const cueScore = (claimKey: string, line: string): number => {
  const normalized = line.toLowerCase();
  return (CUES[claimKey] ?? []).reduce(
    (score, cue) => score + (normalized.includes(cue) ? 1 : 0),
    0
  );
};

export const buildFixtureSearchQuery = (task: Readonly<AgentTask>): string => {
  const cues = task.claims
    .map((claim) => CUES[claim.claimKey]?.[0])
    .filter((cue): cue is string => !!cue);
  return [...new Set(cues)].join(" ") || task.brief.goal;
};

const citeLine = ({
  evidence,
  line,
  text,
}: EvidenceLine): EvidenceCoordinate => ({
  uri: evidence.uri,
  sourceHash: evidence.sourceHash,
  startLine: line,
  endLine: line,
  spanHash: sha256Bytes(text),
  sourceHashProvenance: "harness_observed",
  spanHashProvenance: "harness_observed",
});

const afterLabel = (line: string): string | null => {
  const separator = Math.max(line.indexOf(":"), line.indexOf("："));
  if (separator >= 0) return line.slice(separator + 1).trim();
  const decision = line.match(/\buse\s+(.+?)(?:\s+for\b|[.;]|$)/i)?.[1];
  return decision?.trim() ?? null;
};

const selectLines = (
  task: Readonly<AgentTask>,
  claimKey: string,
  evidence: readonly AgentVisibleToolResult["evidence"][number][]
): EvidenceLine[] => {
  const lines = evidenceLines(evidence).filter((line) => line.text.trim());
  const scored = lines.filter((line) => cueScore(claimKey, line.text) > 0);
  if (scored.length === 0) return [];
  if (task.category === "multi_document_comparison") return scored;
  if (task.brief.goal.toLowerCase().includes("earliest")) return scored;
  if (
    task.brief.goal.toLowerCase().includes("newer") ||
    task.brief.goal.toLowerCase().includes("current") ||
    task.brief.goal.toLowerCase().includes("final")
  ) {
    return [scored.at(-1) as EvidenceLine];
  }
  return [scored[0] as EvidenceLine];
};

const extractValue = (
  task: Readonly<AgentTask>,
  claimKey: string,
  type: AgentTask["claims"][number]["valueType"],
  lines: readonly EvidenceLine[]
): ClaimValue | null => {
  const texts = lines.map((line) => line.text);
  if (type === "boolean") {
    const hasFalse = texts.some((text) => BOOLEAN_FALSE.test(text));
    const hasTrue = texts.some((text) => BOOLEAN_TRUE.test(text));
    if (!(hasFalse || hasTrue)) return null;
    return { type, value: hasFalse ? false : true };
  }
  if (type === "identifier") {
    const values = texts.flatMap(
      (text) => text.match(IDENTIFIER_PATTERN) ?? []
    );
    return values[0] ? { type, value: values[0] } : null;
  }
  if (type === "date") {
    const values = texts
      .flatMap((text) => text.match(DATE_PATTERN) ?? [])
      .sort();
    if (values.length === 0) return null;
    const earliest = task.brief.goal.toLowerCase().includes("earliest");
    return {
      type,
      value: earliest ? (values[0] as string) : (values.at(-1) as string),
    };
  }
  if (type === "number") {
    const values = texts
      .flatMap((text) => text.match(NUMBER_PATTERN) ?? [])
      .map(Number)
      .filter(Number.isFinite);
    return values.length > 0 ? { type, value: Math.max(...values) } : null;
  }
  if (type === "string[]") {
    const values = texts
      .map(afterLabel)
      .filter((value): value is string => !!value);
    return values.length > 0
      ? { type, value: [...new Set(values)].sort() }
      : null;
  }
  if (claimKey === "retentionComparison" && lines.length >= 2) {
    const values = lines.map((line) => afterLabel(line.text)).filter(Boolean);
    return values.length >= 2
      ? {
          type: "string",
          value: `Standard: ${values[0]}; Regulated: ${values[1]}`,
        }
      : null;
  }
  if (claimKey === "selectedDatabase") {
    const decision = texts[0]?.match(/\buse\s+(.+?)(?:\s+for\b|[.;]|$)/i)?.[1];
    return decision ? { type: "string", value: decision.trim() } : null;
  }
  const value = afterLabel(texts[0] ?? "");
  return value ? { type: "string", value } : null;
};

const buildFinalEnvelope = (
  task: Readonly<AgentTask>,
  evidence: readonly AgentVisibleToolResult["evidence"][number][]
): FinalEnvelope => {
  const claims: FinalClaim[] = [];
  const gaps: FinalEnvelope["gaps"] = [];
  for (const definition of task.claims) {
    const lines = selectLines(task, definition.claimKey, evidence);
    const value = extractValue(
      task,
      definition.claimKey,
      definition.valueType,
      lines
    );
    if (!value) {
      gaps.push({ claimKey: definition.claimKey, reason: "missing_evidence" });
      continue;
    }
    claims.push({
      claimKey: definition.claimKey,
      value,
      citations: lines.map(citeLine),
    });
  }
  const abstained = claims.length === 0;
  return {
    schemaVersion: "1.0",
    claims,
    gaps,
    abstained,
    stopReason: abstained ? "abstained" : "complete",
  };
};

export const parseFinalEnvelope = (
  task: Readonly<AgentTask>,
  raw: string
): FinalEnvelope => {
  const parsed = parseStrictAgentJson(raw);
  assertAgenticSchema("final-envelope", parsed);
  const issues = validateFinalEnvelopeSemantics(task, parsed);
  if (issues.length > 0) {
    throw new AgenticAgentError(
      "invalid_final_envelope",
      issues.map((issue) => `${issue.code}:${issue.claimKey}`).join(",")
    );
  }
  return parsed;
};

class FixtureAgentSession implements OuterAgentSession {
  readonly agentId = FIXTURE_AGENT_VERSION;
  readonly promptFingerprint: string;
  readonly modelFingerprint = canonicalFingerprint({
    agent: FIXTURE_AGENT_VERSION,
    stateMachine: "search-read-final-v1",
  });
  readonly tokenizerFingerprint = null;

  constructor(
    private readonly task: Readonly<AgentTask>,
    private readonly toolNames: ReadonlySet<string>
  ) {
    this.promptFingerprint = canonicalFingerprint({
      system: FIXTURE_AGENT_PROMPT,
      brief: task.brief,
      claims: task.claims,
    });
  }

  async next(
    calls: Parameters<OuterAgentSession["next"]>[0]
  ): Promise<AgentStep> {
    if (calls.length === 0) {
      if (!this.toolNames.has("search")) {
        return { kind: "final", envelope: this.unavailableEnvelope() };
      }
      return {
        kind: "tool",
        toolName: "search",
        arguments: {
          query: buildFixtureSearchQuery(this.task),
          collection: this.task.corpus.collections[0],
        },
      };
    }
    const lastCall = calls.at(-1);
    const readEvidence = calls
      .filter((call) => call.result.resultRole !== "candidates")
      .flatMap((call) => evidenceVisibleInBundleContent(call.result));
    const candidateEvidence = calls
      .filter((call) => call.result.resultRole === "candidates")
      .flatMap((call) => call.result.evidence);
    if (
      lastCall?.result.resultRole === "candidates" &&
      candidateEvidence.length > 0
    ) {
      if (calls.length >= this.task.budgets.maxAgentCalls) {
        return {
          kind: "final",
          envelope: buildFinalEnvelope(this.task, candidateEvidence),
        };
      }
      const relevantLines = this.task.claims.flatMap((claim) =>
        selectLines(this.task, claim.claimKey, lastCall.result.evidence)
      );
      const uris = [
        ...new Set(
          (relevantLines.length > 0 ? relevantLines : candidateEvidence).map(
            (item) => ("evidence" in item ? item.evidence.uri : item.uri)
          )
        ),
      ];
      if (uris.length > 1 && this.toolNames.has("multi_get")) {
        return {
          kind: "tool",
          toolName: "multi_get",
          arguments: { uris },
        };
      }
      const line = relevantLines[0];
      return {
        kind: "tool",
        toolName: "get",
        arguments: {
          uri: uris[0],
          ...(line ? { fromLine: line.line, lineCount: 1 } : {}),
        },
      };
    }
    const envelope = buildFinalEnvelope(
      this.task,
      readEvidence.length > 0 ? readEvidence : candidateEvidence
    );
    return { kind: "final", envelope };
  }

  countTokens(): null {
    return null;
  }

  async dispose(): Promise<void> {}

  private unavailableEnvelope(): FinalEnvelope {
    return {
      schemaVersion: "1.0",
      claims: [],
      gaps: this.task.claims.map((claim) => ({
        claimKey: claim.claimKey,
        reason: "tool_unavailable" as const,
      })),
      abstained: true,
      stopReason: "tool_unavailable",
    };
  }
}

export class FixtureAgentFactory implements OuterAgentFactory {
  readonly agentId = FIXTURE_AGENT_VERSION;

  trials() {
    return [{ trialId: "fixture-01", seed: 0 }] as const;
  }

  async open(_signal: AbortSignal) {
    const runtime: OuterAgentRuntime = {
      async createSession(context: AgentCreateContext) {
        return new FixtureAgentSession(
          context.task,
          new Set(context.tools.map((tool) => tool.name))
        );
      },
      async dispose() {},
    };
    return {
      runtime,
      modelLoadMs: null,
    };
  }
}
