// node:path: path construction has no Bun equivalent.
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type {
  AgentCreateContext,
  AgentStep,
  OuterAgentFactory,
  OuterAgentRuntime,
  OuterAgentSession,
} from "./agent";
import type { FinalEnvelope } from "./types";

import { CONFIG_VERSION, DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import { LlmAdapter } from "../../src/llm/nodeLlamaCpp/adapter";
import { AgenticAgentError, AgenticHarnessError } from "./adapter";
import {
  assertSha256,
  canonicalFingerprint,
  canonicalJson,
  sha256Bytes,
} from "./canonical";
import { FIXTURE_AGENT_PROMPT, parseFinalEnvelope } from "./fixture-agent";
import { parseStrictAgentJson, parseStrictHarnessJson } from "./strict-json";

export const AGENT_MODEL_LOCK_PATH = join(
  import.meta.dir,
  "../fixtures/agentic-retrieval/agent-model.lock.json"
);

export interface AgentModelLock {
  schemaVersion: "1.0";
  modelUri: string;
  fileSha256: string;
  tokenizer: {
    identifier: string;
    sha256: string;
    checksumScope: "embedded-in-model-file";
  };
  maximumSteps: number;
  maximumOutputTokens: number;
  seedSchedule: Array<{ trialId: string; seed: number }>;
}

export interface LocalModelRuntime {
  load(signal: AbortSignal): Promise<void>;
  generate(
    prompt: string,
    seed: number,
    maxTokens: number,
    signal: AbortSignal
  ): Promise<string>;
  countTokens(text: string): number;
  dispose(): Promise<void>;
}

export type LocalModelRuntimeFactory = (
  modelPath: string,
  lock: AgentModelLock
) => Promise<LocalModelRuntime>;

const PLACEHOLDER_PATTERN = /(?:placeholder|example|todo|replace[-_ ]?me)/i;

const assertPlainObject = (
  value: unknown,
  label: string
): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgenticHarnessError(
      "invalid_model_lock",
      `${label} must be an object`
    );
  }
  return value as Record<string, unknown>;
};

const assertExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new AgenticHarnessError(
      "invalid_model_lock",
      `${label} fields differ from the locked contract`
    );
  }
};

export const validateAgentModelLock = (value: unknown): AgentModelLock => {
  const lock = assertPlainObject(value, "Agent model lock");
  assertExactKeys(
    lock,
    [
      "schemaVersion",
      "modelUri",
      "fileSha256",
      "tokenizer",
      "maximumSteps",
      "maximumOutputTokens",
      "seedSchedule",
    ],
    "Agent model lock"
  );
  const tokenizer = assertPlainObject(lock.tokenizer, "Tokenizer lock");
  assertExactKeys(
    tokenizer,
    ["identifier", "sha256", "checksumScope"],
    "Tokenizer lock"
  );
  if (lock.schemaVersion !== "1.0") {
    throw new AgenticHarnessError(
      "invalid_model_lock",
      "Unsupported lock schema"
    );
  }
  if (
    typeof lock.modelUri !== "string" ||
    !lock.modelUri.startsWith("hf:") ||
    PLACEHOLDER_PATTERN.test(lock.modelUri)
  ) {
    throw new AgenticHarnessError(
      "invalid_model_lock",
      "Model URI must be one exact non-placeholder hf: URI"
    );
  }
  if (typeof lock.fileSha256 !== "string") {
    throw new AgenticHarnessError(
      "invalid_model_lock",
      "Missing model checksum"
    );
  }
  assertSha256(lock.fileSha256, "Model file checksum");
  if (lock.fileSha256 === "0".repeat(64)) {
    throw new AgenticHarnessError(
      "invalid_model_lock",
      "Placeholder checksum refused"
    );
  }
  if (
    typeof tokenizer.identifier !== "string" ||
    !tokenizer.identifier.trim() ||
    PLACEHOLDER_PATTERN.test(tokenizer.identifier) ||
    tokenizer.checksumScope !== "embedded-in-model-file" ||
    tokenizer.sha256 !== lock.fileSha256
  ) {
    throw new AgenticHarnessError(
      "invalid_model_lock",
      "Tokenizer must be exact and checksum-bound to the embedded GGUF tokenizer"
    );
  }
  if (
    !Number.isInteger(lock.maximumSteps) ||
    (lock.maximumSteps as number) < 1 ||
    !Number.isInteger(lock.maximumOutputTokens) ||
    (lock.maximumOutputTokens as number) < 1
  ) {
    throw new AgenticHarnessError(
      "invalid_model_lock",
      "Invalid model budgets"
    );
  }
  if (!Array.isArray(lock.seedSchedule) || lock.seedSchedule.length !== 3) {
    throw new AgenticHarnessError(
      "invalid_model_lock",
      "Local-model lane requires exactly three paired trials"
    );
  }
  const trialIds = new Set<string>();
  const seeds = new Set<number>();
  for (const item of lock.seedSchedule) {
    const trial = assertPlainObject(item, "Seed schedule item");
    assertExactKeys(trial, ["trialId", "seed"], "Seed schedule item");
    if (
      typeof trial.trialId !== "string" ||
      !/^local-0[1-3]$/.test(trial.trialId) ||
      !Number.isInteger(trial.seed) ||
      trialIds.has(trial.trialId) ||
      seeds.has(trial.seed as number)
    ) {
      throw new AgenticHarnessError(
        "invalid_model_lock",
        "Invalid paired seed schedule"
      );
    }
    trialIds.add(trial.trialId);
    seeds.add(trial.seed as number);
  }
  return structuredClone(lock) as unknown as AgentModelLock;
};

const sha256File = async (path: string): Promise<string> => {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new AgenticHarnessError(
      "model_file_missing",
      "Locked local model is absent"
    );
  }
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = file.stream().getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hasher.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return hasher.digest("hex");
};

export const loadAndPreflightAgentModelLock = async (
  modelPath: string | undefined,
  lockPath = AGENT_MODEL_LOCK_PATH
): Promise<AgentModelLock> => {
  if (!modelPath) {
    throw new AgenticHarnessError(
      "model_path_missing",
      "Set GNO_AGENTIC_MODEL_PATH to the already-cached locked GGUF"
    );
  }
  const lockFile = Bun.file(lockPath);
  if (!(await lockFile.exists())) {
    throw new AgenticHarnessError(
      "model_lock_missing",
      "Agent model lock is absent"
    );
  }
  const lock = validateAgentModelLock(
    parseStrictHarnessJson(await lockFile.text(), "Agent model lock")
  );
  const actual = await sha256File(modelPath);
  if (actual !== lock.fileSha256) {
    throw new AgenticHarnessError(
      "model_checksum_mismatch",
      `Locked model checksum mismatch: expected ${lock.fileSha256}, received ${actual}`
    );
  }
  return lock;
};

const createDefaultRuntime: LocalModelRuntimeFactory = async (
  modelPath,
  lock
) => {
  const fileUri = `file:${modelPath}`;
  const config: Config = {
    version: CONFIG_VERSION,
    ftsTokenizer: DEFAULT_FTS_TOKENIZER,
    collections: [],
    contexts: [],
    models: {
      activePreset: "agentic-locked",
      presets: [
        {
          id: "agentic-locked",
          name: "Agentic benchmark locked model",
          embed: fileUri,
          rerank: fileUri,
          expand: fileUri,
          gen: fileUri,
        },
      ],
      loadTimeout: 120_000,
      inferenceTimeout: 60_000,
      expandContextSize: 4096,
      warmModelTtl: 300_000,
    },
  };
  const adapter = new LlmAdapter(config);
  const portResult = await adapter.createGenerationPort(fileUri, {
    policy: { offline: true, allowDownload: false },
  });
  if (!portResult.ok) {
    throw new AgenticHarnessError(
      "model_port_failed",
      portResult.error.message
    );
  }
  const manager = adapter.getManager();
  return {
    async load(signal) {
      signal.throwIfAborted();
      const loaded = await manager.loadModel(modelPath, fileUri, "gen");
      if (!loaded.ok) {
        throw new AgenticHarnessError(
          "model_load_failed",
          loaded.error.message
        );
      }
    },
    async generate(prompt, seed, maxTokens, signal) {
      signal.throwIfAborted();
      const generated = await portResult.value.generate(prompt, {
        temperature: 0,
        seed,
        maxTokens,
      });
      if (!generated.ok) {
        throw new AgenticAgentError(
          "model_generation_failed",
          generated.error.message
        );
      }
      signal.throwIfAborted();
      return generated.value;
    },
    countTokens(text) {
      const model = adapter.getManager().getLoadedModel(fileUri)?.model as
        | { tokenize(value: string): unknown[] }
        | undefined;
      if (!model)
        throw new AgenticHarnessError(
          "tokenizer_unavailable",
          "Pinned tokenizer is not loaded"
        );
      return model.tokenize(text).length;
    },
    async dispose() {
      await adapter.dispose();
    },
  };
};

const localPrompt = (context: AgentCreateContext, calls: unknown): string =>
  `${FIXTURE_AGENT_PROMPT}\n\nReturn either {"kind":"tool","toolName":string,"arguments":object} or a FinalEnvelope JSON value.\nVisible task:\n${canonicalJson(context.task)}\nTool schemas:\n${canonicalJson(context.tools)}\nPrior normalized calls:\n${canonicalJson(calls)}`;

class LocalModelSession implements OuterAgentSession {
  readonly agentId = "cached-local-model-v1";
  readonly promptFingerprint: string;
  readonly modelFingerprint: string;
  readonly tokenizerFingerprint: string;

  constructor(
    private readonly context: AgentCreateContext,
    private readonly lock: AgentModelLock,
    private readonly runtime: LocalModelRuntime
  ) {
    this.promptFingerprint = canonicalFingerprint({
      prompt: FIXTURE_AGENT_PROMPT,
      task: context.task,
      tools: context.tools,
    });
    this.modelFingerprint = canonicalFingerprint({
      uri: lock.modelUri,
      sha256: lock.fileSha256,
    });
    this.tokenizerFingerprint = canonicalFingerprint(lock.tokenizer);
  }

  async next(
    calls: Parameters<OuterAgentSession["next"]>[0],
    signal: AbortSignal
  ): Promise<AgentStep> {
    if (calls.length >= this.lock.maximumSteps) {
      return { kind: "final", envelope: this.budgetEnvelope() };
    }
    const raw = await this.runtime.generate(
      localPrompt(this.context, calls),
      this.context.trial.seed,
      this.lock.maximumOutputTokens,
      signal
    );
    const parsed = parseStrictAgentJson(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const action = parsed as Record<string, unknown>;
      if (action.kind === "tool") {
        const keys = Object.keys(action).sort();
        if (
          canonicalJson(keys) !==
            canonicalJson(["arguments", "kind", "toolName"]) ||
          typeof action.toolName !== "string" ||
          !action.arguments ||
          typeof action.arguments !== "object" ||
          Array.isArray(action.arguments)
        ) {
          throw new AgenticAgentError(
            "invalid_agent_action",
            "Malformed tool action"
          );
        }
        return {
          kind: "tool",
          toolName: action.toolName,
          arguments: action.arguments as Record<string, unknown>,
        };
      }
    }
    return {
      kind: "final",
      envelope: parseFinalEnvelope(this.context.task, raw),
    };
  }

  countTokens(modelVisiblePayload: string): number {
    return this.runtime.countTokens(modelVisiblePayload);
  }

  async dispose(): Promise<void> {}

  private budgetEnvelope(): FinalEnvelope {
    return {
      schemaVersion: "1.0",
      claims: [],
      gaps: this.context.task.claims.map((claim) => ({
        claimKey: claim.claimKey,
        reason: "budget_exhausted" as const,
      })),
      abstained: true,
      stopReason: "budget_exhausted",
    };
  }
}

export class LocalModelAgentFactory implements OuterAgentFactory {
  readonly agentId = "cached-local-model-v1";
  private lockPromise: Promise<AgentModelLock> | null = null;

  constructor(
    private readonly modelPath = process.env.GNO_AGENTIC_MODEL_PATH,
    private readonly runtimeFactory: LocalModelRuntimeFactory = createDefaultRuntime,
    private readonly lockPath = AGENT_MODEL_LOCK_PATH
  ) {}

  trials() {
    return this.getLock().then((lock) => lock.seedSchedule);
  }

  async open(signal: AbortSignal) {
    const lock = await this.getLock();
    const runtime = await this.runtimeFactory(this.modelPath as string, lock);
    const started = performance.now();
    await runtime.load(signal);
    const outerRuntime: OuterAgentRuntime = {
      async createSession(context: AgentCreateContext) {
        return new LocalModelSession(context, lock, runtime);
      },
      async dispose() {
        await runtime.dispose();
      },
    };
    return {
      runtime: outerRuntime,
      modelLoadMs: Number((performance.now() - started).toFixed(3)),
    };
  }

  private getLock(): Promise<AgentModelLock> {
    this.lockPromise ??= loadAndPreflightAgentModelLock(
      this.modelPath,
      this.lockPath
    );
    return this.lockPromise;
  }
}

export const agentModelLockFingerprint = (lock: AgentModelLock): string =>
  sha256Bytes(canonicalJson(lock));
