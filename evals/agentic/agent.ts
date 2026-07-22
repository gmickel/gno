import type { AgentToolDefinition } from "./adapter";
import type { AgentVisibleCall, AgentTask, FinalEnvelope } from "./types";

export interface AgentTrial {
  trialId: string;
  seed: number;
}

export interface AgentCreateContext {
  task: Readonly<AgentTask>;
  tools: readonly AgentToolDefinition[];
  trial: AgentTrial;
}

export type AgentStep =
  | {
      kind: "tool";
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | { kind: "final"; envelope: FinalEnvelope };

export interface OuterAgentSession {
  readonly agentId: string;
  readonly promptFingerprint: string;
  readonly modelFingerprint: string;
  readonly tokenizerFingerprint: string | null;
  next(
    calls: readonly AgentVisibleCall[],
    signal: AbortSignal
  ): Promise<AgentStep>;
  countTokens(modelVisiblePayload: string): number | null;
  dispose(): Promise<void>;
}

export interface OuterAgentRuntime {
  createSession(
    context: AgentCreateContext,
    signal: AbortSignal
  ): Promise<OuterAgentSession>;
  dispose(): Promise<void>;
}

export interface AgentRuntimeStart {
  runtime: OuterAgentRuntime;
  modelLoadMs: number | null;
}

export interface OuterAgentFactory {
  readonly agentId: string;
  trials(): readonly AgentTrial[] | Promise<readonly AgentTrial[]>;
  open(signal: AbortSignal): Promise<AgentRuntimeStart>;
}
