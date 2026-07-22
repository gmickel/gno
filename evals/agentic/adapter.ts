import type {
  AgentTask,
  AdapterCapabilitySnapshot,
  CorpusSnapshot,
  NormalizedToolResult,
  TimingObservation,
} from "./types";

import { assertSha256, canonicalFingerprint } from "./canonical";

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const CANONICAL_AGENT_TOOL_NAMES = [
  "search",
  "get",
  "multi_get",
] as const;
export type CanonicalAgentToolName =
  (typeof CANONICAL_AGENT_TOOL_NAMES)[number];

const freezeDeep = <T>(value: T): Readonly<T> => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
    Object.freeze(value);
  }
  return value;
};

export const CANONICAL_AGENT_TOOLS: readonly AgentToolDefinition[] = freezeDeep(
  [
    {
      name: "get",
      description: "Read one source or exact inclusive line range.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["uri"],
        properties: {
          uri: { type: "string" },
          fromLine: { type: "integer", minimum: 1 },
          lineCount: { type: "integer", minimum: 1 },
        },
      },
    },
    {
      name: "multi_get",
      description: "Read multiple sources by URI.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["uris"],
        properties: {
          uris: { type: "array", minItems: 1, items: { type: "string" } },
          maxBytes: { type: "integer", minimum: 1 },
        },
      },
    },
    {
      name: "search",
      description: "Search task-visible sources with optional scope.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string" },
          collection: { type: "string" },
          filters: { type: "object" },
          limit: { type: "integer", minimum: 1 },
          minScore: { type: "number" },
          lang: { type: "string" },
          intent: { type: "string" },
          candidateLimit: { type: "integer", minimum: 1 },
          exclude: { type: "array", items: { type: "string" } },
          since: { type: "string" },
          until: { type: "string" },
          categories: { type: "array", items: { type: "string" } },
          author: { type: "string" },
          queryModes: { type: "array", items: { type: "object" } },
          fast: { type: "boolean" },
          thorough: { type: "boolean" },
          expand: { type: "boolean" },
          rerank: { type: "boolean" },
          graph: { type: "boolean" },
          tagsAll: { type: "array", items: { type: "string" } },
          tagsAny: { type: "array", items: { type: "string" } },
        },
      },
    },
  ]
);

export type CapabilityState = "supported" | "unsupported" | "unavailable";
export type AdapterCapabilities = AdapterCapabilitySnapshot;

const CAPABILITY_STATES = new Set<CapabilityState>([
  "supported",
  "unsupported",
  "unavailable",
]);

const hasExactKeys = (
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

export function validateAdapterCapabilities(
  value: unknown
): asserts value is AdapterCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgenticHarnessError(
      "invalid_adapter_capabilities",
      "Adapter capabilities must be an object"
    );
  }
  const capabilities = value as Record<string, unknown>;
  if (
    !hasExactKeys(capabilities, [
      "backendInvocationAccounting",
      "startupTiming",
      "modelLoadTiming",
      "toolTiming",
      "tools",
      "exactLineSpans",
      "measuredTokens",
      "backendHashes",
      "lifecycle",
    ]) ||
    ![
      "backendInvocationAccounting",
      "startupTiming",
      "modelLoadTiming",
      "toolTiming",
    ].every((key) => typeof capabilities[key] === "boolean")
  ) {
    throw new AgenticHarnessError(
      "invalid_adapter_capabilities",
      "Adapter capability fields differ from the contract"
    );
  }
  const tools = capabilities.tools;
  const lifecycle = capabilities.lifecycle;
  if (
    !tools ||
    typeof tools !== "object" ||
    Array.isArray(tools) ||
    !hasExactKeys(
      tools as Record<string, unknown>,
      CANONICAL_AGENT_TOOL_NAMES
    ) ||
    !Object.values(tools).every((state) =>
      CAPABILITY_STATES.has(state as CapabilityState)
    ) ||
    !lifecycle ||
    typeof lifecycle !== "object" ||
    Array.isArray(lifecycle) ||
    !hasExactKeys(lifecycle as Record<string, unknown>, ["cold", "warm"]) ||
    !Object.values(lifecycle).every((state) =>
      CAPABILITY_STATES.has(state as CapabilityState)
    ) ||
    !["exactLineSpans", "measuredTokens", "backendHashes"].every((key) =>
      CAPABILITY_STATES.has(capabilities[key] as CapabilityState)
    )
  ) {
    throw new AgenticHarnessError(
      "invalid_adapter_capabilities",
      "Adapter capability values differ from the contract"
    );
  }
}

export interface AdapterPreparation {
  adapterId: string;
  corpusFingerprint: string;
  indexFingerprint: string;
  preparation: TimingObservation;
  observations: Record<string, string | number | boolean | null>;
  tempPaths: string[];
  /** Adapter-owned immutable handle, excluded from canonical receipts. */
  handle: unknown;
}

export interface AdapterPrepareContext {
  snapshot: CorpusSnapshot;
  prepared: AdapterPreparation | null;
  signal: AbortSignal;
}

export interface AdapterResetContext {
  task: Readonly<AgentTask>;
  lifecycle: "cold" | "warm";
  readinessProbe: boolean;
  signal: AbortSignal;
}

export interface AdapterResetResult {
  startup: TimingObservation;
  modelLoad: TimingObservation;
  diagnostics: string[];
}

export interface AdapterToolCallResult {
  result: NormalizedToolResult;
  backendInvocations: number;
  timing: TimingObservation;
  diagnostics: string[];
}

export interface AgentAdapter {
  readonly adapterId: string;
  readonly capabilities: AdapterCapabilities;
  readonly configFingerprint: string;
  prepare(context: AdapterPrepareContext): Promise<AdapterPreparation>;
  listTools(): Promise<readonly AgentToolDefinition[]>;
  callTool(
    toolName: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<AdapterToolCallResult>;
  reset(context: AdapterResetContext): Promise<AdapterResetResult>;
  dispose(): Promise<void>;
}

export type AgentAdapterFactory = () => AgentAdapter;

export class AgentAdapterRegistry {
  private readonly factories = new Map<string, AgentAdapterFactory>();

  register(adapterId: string, factory: AgentAdapterFactory): this {
    if (!adapterId.trim() || this.factories.has(adapterId)) {
      throw new AgenticHarnessError(
        "adapter_registration_invalid",
        `Adapter registration is empty or duplicated: ${adapterId}`
      );
    }
    this.factories.set(adapterId, factory);
    return this;
  }

  get(adapterId: string): AgentAdapterFactory {
    const factory = this.factories.get(adapterId);
    if (!factory) {
      throw new AgenticHarnessError(
        "adapter_not_registered",
        `Agentic adapter is not registered: ${adapterId}`
      );
    }
    return factory;
  }

  ids(): string[] {
    return [...this.factories.keys()].sort();
  }
}

export interface AgenticErrorOptions extends ErrorOptions {
  backendInvocations?: number;
}

const backendInvocationMetadata = (
  options?: AgenticErrorOptions
): number | null => {
  const count = options?.backendInvocations;
  return Number.isSafeInteger(count) && (count as number) >= 0
    ? (count as number)
    : null;
};

export class AgenticHarnessError extends Error {
  readonly code: string;
  readonly backendInvocations: number | null;

  constructor(code: string, message: string, options?: AgenticErrorOptions) {
    super(message, options);
    this.name = "AgenticHarnessError";
    this.code = code;
    this.backendInvocations = backendInvocationMetadata(options);
  }
}

export class AgenticAgentError extends Error {
  readonly code: string;
  readonly backendInvocations: number | null;

  constructor(code: string, message: string, options?: AgenticErrorOptions) {
    super(message, options);
    this.name = "AgenticAgentError";
    this.code = code;
    this.backendInvocations = backendInvocationMetadata(options);
  }
}

export class AgenticProductError extends Error {
  readonly code: string;
  readonly backendInvocations: number | null;

  constructor(code: string, message: string, options?: AgenticErrorOptions) {
    super(message, options);
    this.name = "AgenticProductError";
    this.code = code;
    this.backendInvocations = backendInvocationMetadata(options);
  }
}

export const withBackendInvocations = (
  error: unknown,
  backendInvocations: number
): Error => {
  const options = { cause: error, backendInvocations };
  if (error instanceof AgenticHarnessError)
    return new AgenticHarnessError(error.code, error.message, options);
  if (error instanceof AgenticAgentError)
    return new AgenticAgentError(error.code, error.message, options);
  if (error instanceof AgenticProductError)
    return new AgenticProductError(error.code, error.message, options);
  return new AgenticHarnessError(
    "tool_result_normalization_failed",
    "Adapter tool result normalization failed",
    options
  );
};

export const unavailableTiming = (reason: string): TimingObservation => ({
  valueMs: null,
  unavailableReason: reason,
});

export const measuredTiming = (valueMs: number): TimingObservation => ({
  valueMs: Math.max(0, Number(valueMs.toFixed(3))),
  unavailableReason: null,
});

export const validateAdapterPreparation = (
  preparation: AdapterPreparation,
  adapterId: string,
  snapshot: CorpusSnapshot
): void => {
  if (
    !preparation ||
    typeof preparation !== "object" ||
    Array.isArray(preparation) ||
    !hasExactKeys(preparation as unknown as Record<string, unknown>, [
      "adapterId",
      "corpusFingerprint",
      "indexFingerprint",
      "preparation",
      "observations",
      "tempPaths",
      "handle",
    ]) ||
    !preparation.observations ||
    typeof preparation.observations !== "object" ||
    Array.isArray(preparation.observations) ||
    !Object.values(preparation.observations).every(
      (value) =>
        value === null ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        typeof value === "boolean"
    ) ||
    !Array.isArray(preparation.tempPaths) ||
    !preparation.tempPaths.every((path) => typeof path === "string") ||
    !preparation.preparation ||
    typeof preparation.preparation !== "object" ||
    Array.isArray(preparation.preparation) ||
    !hasExactKeys(
      preparation.preparation as unknown as Record<string, unknown>,
      ["valueMs", "unavailableReason"]
    ) ||
    !(
      (typeof preparation.preparation.valueMs === "number" &&
        Number.isFinite(preparation.preparation.valueMs) &&
        preparation.preparation.valueMs >= 0 &&
        preparation.preparation.unavailableReason === null) ||
      (preparation.preparation.valueMs === null &&
        typeof preparation.preparation.unavailableReason === "string" &&
        preparation.preparation.unavailableReason.trim().length > 0)
    )
  ) {
    throw new AgenticHarnessError(
      "invalid_adapter_preparation",
      "Adapter preparation differs from the closed contract"
    );
  }
  if (preparation.adapterId !== adapterId) {
    throw new AgenticHarnessError(
      "adapter_identity_mismatch",
      `Adapter preparation identity mismatch: ${preparation.adapterId}`
    );
  }
  if (preparation.corpusFingerprint !== snapshot.fingerprint) {
    throw new AgenticHarnessError(
      "corpus_fingerprint_mismatch",
      "Adapter index was not built from the requested corpus snapshot"
    );
  }
  try {
    assertSha256(preparation.indexFingerprint, "Adapter index fingerprint");
  } catch (error) {
    throw new AgenticHarnessError(
      "invalid_adapter_preparation",
      "Adapter index fingerprint is invalid",
      { cause: error }
    );
  }
};

export const fingerprintTools = (
  tools: readonly AgentToolDefinition[]
): string =>
  canonicalFingerprint(
    [...tools]
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"))
  );
