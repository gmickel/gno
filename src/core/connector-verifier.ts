/** Read-only, privacy-bounded connector activation verification. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
// node:path has no Bun equivalent for portable resolved path identity.
import { resolve } from "node:path";

import type {
  ActivationStageReceipt,
  ActivationVerificationReceipt,
  StorePort,
  StoreResult,
} from "../store/types";

import { DEFAULT_INDEX_NAME, parseUri } from "../app/constants";
import { MCP_ACTIVATION_VERIFICATION_ENV } from "../mcp/activation-verification-mode";
import { err, ok } from "../store/types";
import {
  createEphemeralActivationProbePlan,
  findEphemeralActivationProbeMatch,
  revalidateEphemeralActivationProbePlan,
} from "./activation-probe-plan";
import { persistActivationReceiptForKnownCollection } from "./activation-receipt-store";
import { verifyLexicalActivation } from "./activation-verifier";
import {
  type ConnectorCommandPolicyOptions,
  type ConnectorVerificationCode,
  isSafeLocalGnoMcpCommand,
} from "./connector-policy";

export {
  getConnectorVerificationRemediation,
  isSafeLocalGnoMcpCommand,
} from "./connector-policy";
export type { ConnectorVerificationCode } from "./connector-policy";

const CONNECTOR_VERIFIER_IMPLEMENTATION_ID = "mcp-stdio-readonly-v2";
const DEFAULT_TIMEOUT_MS = 5000;
const CONCURRENT_INDEX_CHANGE_MESSAGE =
  "Activation index changed during connector verification; retry";
const REQUIRED_TOOLS = new Set(["gno_status", "gno_search"]);

interface ConnectorTargetBase {
  id: string;
  target: string;
  scope: "user" | "project";
  configPath: string;
  configError?: boolean;
}

export interface McpConnectorVerificationTarget extends ConnectorTargetBase {
  kind: "mcp";
  configured: boolean;
  serverEntry?: { command: string; args: string[] };
  /** Privacy-bounded identity of the complete client entry. */
  configIdentity?: string;
}

export interface SkillConnectorVerificationTarget extends ConnectorTargetBase {
  kind: "skill";
  installed: boolean;
  /** Reserved for a future client-owned, read-only runtime verification hook. */
  runtimeHook?: never;
}

export type ConnectorVerificationTarget =
  | McpConnectorVerificationTarget
  | SkillConnectorVerificationTarget;

export interface ConnectorVerifierOptions {
  force?: boolean;
  timeoutMs?: number;
  now?: () => Date;
  monotonicNow?: () => number;
  /** Trusted installer/runtime entries added to the default provenance set. */
  commandPolicy?: ConnectorCommandPolicyOptions;
}

interface McpProofInput {
  command: string;
  args: string[];
  collection: string;
  /** Sensitive corpus-derived term. Never serialize or log. */
  term: string;
  expectedUri: string;
  expectedSourceHash: string;
  expectedIndexName: string;
  timeoutMs: number;
}

type McpProofResult =
  | { ok: true }
  | { ok: false; code: ConnectorVerificationCode };

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function elapsedMs(startedAt: number, monotonicNow: () => number): number {
  return Math.max(0, Math.round(monotonicNow() - startedAt));
}

function targetIdentity(target: ConnectorVerificationTarget): {
  connectorTarget: string;
  normalized: Record<string, unknown>;
} {
  const configPathIdentity = sha256(resolve(target.configPath));
  const normalized = {
    kind: target.kind,
    id: target.id,
    target: target.target,
    scope: target.scope,
    configPathIdentity,
    configError: target.configError === true,
    ...(target.kind === "mcp"
      ? {
          configured: target.configured,
          command: target.serverEntry?.command ?? null,
          args: target.serverEntry?.args ?? [],
          configIdentity: target.configIdentity ?? null,
        }
      : { installed: target.installed }),
  };
  return {
    connectorTarget: `${target.kind}:${target.target}:${target.scope}:${configPathIdentity}`,
    normalized,
  };
}

function normalizeConnectorTarget(
  target: ConnectorVerificationTarget
): ConnectorVerificationTarget {
  if (target.kind !== "mcp") {
    return target;
  }
  if (!target.configured) {
    return { ...target, serverEntry: undefined };
  }
  const entry: unknown = target.serverEntry;
  if (!entry || typeof entry !== "object") {
    return { ...target, configured: false, configError: true };
  }
  const record = entry as { command?: unknown; args?: unknown };
  const entryKeys = Object.keys(record);
  if (
    typeof record.command !== "string" ||
    record.command.length === 0 ||
    !Array.isArray(record.args) ||
    !record.args.every((argument) => typeof argument === "string") ||
    entryKeys.some((key) => key !== "command" && key !== "args")
  ) {
    return {
      ...target,
      configured: false,
      serverEntry: undefined,
      configIdentity:
        target.configIdentity ?? sha256(JSON.stringify(entry) ?? "undefined"),
      configError: true,
    };
  }
  return {
    ...target,
    serverEntry: { command: record.command, args: record.args },
  };
}

function connectorFingerprint(
  lexicalFingerprint: string,
  normalizedTarget: Record<string, unknown>
): string {
  return sha256(
    JSON.stringify({
      lexicalFingerprint,
      connectorVerifier: CONNECTOR_VERIFIER_IMPLEMENTATION_ID,
      target: normalizedTarget,
    })
  );
}

/** Pure lookup key for reading one target's fingerprint-current receipt. */
export function getConnectorActivationReceiptLookup(
  lexicalFingerprint: string,
  target: ConnectorVerificationTarget
): { connectorTarget: string; fingerprint: string } {
  const normalizedTarget = normalizeConnectorTarget(target);
  const identity = targetIdentity(normalizedTarget);
  return {
    connectorTarget: identity.connectorTarget,
    fingerprint: connectorFingerprint(lexicalFingerprint, identity.normalized),
  };
}

function connectorStage(
  status: "passed" | "failed" | "skipped",
  startedAt: string | null,
  completedAt: string,
  latencyMs: number | null,
  code?: ConnectorVerificationCode
): ActivationStageReceipt {
  return {
    status,
    startedAt,
    completedAt,
    latencyMs,
    ...(code ? { code } : {}),
  };
}

function buildConnectorReceipt(input: {
  base: ActivationVerificationReceipt;
  fingerprint: string;
  connectorTarget: string;
  generatedAt: string;
  connector: ActivationStageReceipt;
}): ActivationVerificationReceipt {
  return {
    ...input.base,
    fingerprint: input.fingerprint,
    generatedAt: input.generatedAt,
    stages: { ...input.base.stages, connector: input.connector },
    evidence: {
      ...input.base.evidence,
      connectorTarget: input.connectorTarget,
    },
  };
}

async function persistConnectorReceipt(
  store: StorePort,
  receipt: ActivationVerificationReceipt
): Promise<StoreResult<ActivationVerificationReceipt>> {
  return persistActivationReceiptForKnownCollection(store, receipt);
}

async function discardObsoleteConnectorReceipt(
  store: StorePort,
  collection: string,
  currentLexicalFingerprint: string,
  identity: {
    connectorTarget: string;
    normalized: Record<string, unknown>;
  }
): Promise<StoreResult<void>> {
  const currentConnectorFingerprint = connectorFingerprint(
    currentLexicalFingerprint,
    identity.normalized
  );
  const current = await store.getActivationReceipt(
    collection,
    currentConnectorFingerprint,
    identity.connectorTarget
  );
  return current.ok
    ? ok(undefined)
    : err(current.error.code, current.error.message, current.error.cause);
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error.message.toLowerCase().includes("timeout") ||
    error.message.toLowerCase().includes("timed out")
  );
}

function hasExpectedStatusIndex(
  response: unknown,
  expectedIndexName: string
): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const structured = (response as { structuredContent?: unknown })
    .structuredContent;
  return (
    !!structured &&
    typeof structured === "object" &&
    (structured as { indexName?: unknown }).indexName === expectedIndexName
  );
}

function hasExpectedResult(
  response: unknown,
  expectedUri: string,
  expectedSourceHash: string,
  expectedIndexName: string
): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const structured = (response as { structuredContent?: unknown })
    .structuredContent;
  if (!structured || typeof structured !== "object") {
    return false;
  }
  const results = (structured as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return false;
  }
  const expected = parseUri(expectedUri);
  if (!expected) {
    return false;
  }
  return results.some((result) => {
    if (!result || typeof result !== "object") {
      return false;
    }
    const record = result as {
      uri?: unknown;
      source?: { sourceHash?: unknown };
    };
    const uri = typeof record.uri === "string" ? parseUri(record.uri) : null;
    const resultIndexName = uri?.indexName ?? DEFAULT_INDEX_NAME;
    return (
      uri?.collection === expected.collection &&
      uri.path === expected.path &&
      resultIndexName === expectedIndexName &&
      record.source?.sourceHash === expectedSourceHash
    );
  });
}

async function executeMcpProof(input: McpProofInput): Promise<McpProofResult> {
  const client = new Client({
    name: "gno-activation-verifier",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: input.command,
    args: input.args,
    env: {
      ...getDefaultEnvironment(),
      [MCP_ACTIVATION_VERIFICATION_ENV]: "1",
    },
    stderr: "ignore",
  });
  const requestOptions = { timeout: input.timeoutMs };
  let phase: "start" | "tools" | "status" | "search" = "start";
  try {
    await client.connect(transport, requestOptions);
    phase = "tools";
    const tools = await client.listTools(undefined, requestOptions);
    const available = new Set(tools.tools.map(({ name }) => name));
    if (![...REQUIRED_TOOLS].every((name) => available.has(name))) {
      return { ok: false, code: "connector_missing_tools" };
    }

    phase = "status";
    const status = await client.callTool(
      { name: "gno_status", arguments: {} },
      undefined,
      requestOptions
    );
    if (
      status.isError === true ||
      !hasExpectedStatusIndex(status, input.expectedIndexName)
    ) {
      return { ok: false, code: "connector_status_failed" };
    }

    phase = "search";
    let searchResponse: unknown = await client.callTool(
      {
        name: "gno_search",
        arguments: {
          query: input.term,
          collection: input.collection,
          limit: 8,
        },
      },
      undefined,
      requestOptions
    );
    const searchFailed =
      !!searchResponse &&
      typeof searchResponse === "object" &&
      (searchResponse as { isError?: unknown }).isError === true;
    const matched =
      !searchFailed &&
      hasExpectedResult(
        searchResponse,
        input.expectedUri,
        input.expectedSourceHash,
        input.expectedIndexName
      );
    searchResponse = undefined;
    if (searchFailed) {
      return { ok: false, code: "connector_search_failed" };
    }
    return matched
      ? { ok: true }
      : { ok: false, code: "connector_result_mismatch" };
  } catch (error) {
    if (isTimeoutError(error)) {
      return { ok: false, code: "connector_timeout" };
    }
    if (phase === "status") {
      return { ok: false, code: "connector_status_failed" };
    }
    if (phase === "search") {
      return { ok: false, code: "connector_search_failed" };
    }
    if (phase === "tools") {
      return { ok: false, code: "connector_missing_tools" };
    }
    return { ok: false, code: "connector_start_failed" };
  } finally {
    await client.close().catch(async () => transport.close().catch(() => {}));
  }
}

/**
 * Verify one installed connector without changing its config or crossing a
 * user trust prompt. Skill-only targets remain explicitly unverifiable.
 */
export async function verifyConnectorActivation(
  store: StorePort,
  collection: string,
  target: ConnectorVerificationTarget,
  options: ConnectorVerifierOptions = {}
): Promise<StoreResult<ActivationVerificationReceipt>> {
  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const lexical = await verifyLexicalActivation(store, collection, {
    force: options.force,
    now,
    monotonicNow,
  });
  if (!lexical.ok) {
    return lexical;
  }

  const normalizedTarget = normalizeConnectorTarget(target);
  const identity = targetIdentity(normalizedTarget);
  const fingerprint = connectorFingerprint(
    lexical.value.fingerprint,
    identity.normalized
  );
  if (!options.force) {
    const current = await store.getActivationReceipt(
      collection,
      fingerprint,
      identity.connectorTarget
    );
    if (!current.ok) {
      return current;
    }
    if (current.value?.stages.connector.status === "passed") {
      const currentPlan = await createEphemeralActivationProbePlan(
        store,
        collection,
        { collectCandidates: false }
      );
      if (!currentPlan.ok) {
        return currentPlan;
      }
      if (currentPlan.value.fingerprint !== lexical.value.fingerprint) {
        const cleanup = await discardObsoleteConnectorReceipt(
          store,
          collection,
          currentPlan.value.fingerprint,
          identity
        );
        return cleanup.ok
          ? err("INTERNAL", CONCURRENT_INDEX_CHANGE_MESSAGE)
          : cleanup;
      }
      return ok(current.value);
    }
  }

  const startedAt = now().toISOString();
  const startedClock = monotonicNow();
  const finish = async (
    status: "passed" | "failed" | "skipped",
    code?: ConnectorVerificationCode
  ): Promise<StoreResult<ActivationVerificationReceipt>> => {
    const completedAt = now().toISOString();
    return persistConnectorReceipt(
      store,
      buildConnectorReceipt({
        base: lexical.value,
        fingerprint,
        connectorTarget: identity.connectorTarget,
        generatedAt: completedAt,
        connector: connectorStage(
          status,
          startedAt,
          completedAt,
          elapsedMs(startedClock, monotonicNow),
          code
        ),
      })
    );
  };

  if (normalizedTarget.configError) {
    return finish("failed", "connector_unsupported_config");
  }
  if (normalizedTarget.kind === "skill") {
    return finish(
      "skipped",
      normalizedTarget.installed
        ? "target_runtime_unverifiable"
        : "connector_not_configured"
    );
  }
  if (!normalizedTarget.configured) {
    return finish(
      normalizedTarget.configError ? "failed" : "skipped",
      normalizedTarget.configError
        ? "connector_unsupported_config"
        : "connector_not_configured"
    );
  }
  if (
    !normalizedTarget.serverEntry ||
    !(await isSafeLocalGnoMcpCommand(
      normalizedTarget.serverEntry,
      options.commandPolicy
    ))
  ) {
    return finish("failed", "connector_unsupported_config");
  }
  if (!lexical.value.ready) {
    return finish("skipped", "connector_probe_unavailable");
  }

  const plan = await createEphemeralActivationProbePlan(store, collection);
  if (!plan.ok) {
    return plan;
  }
  if (plan.value.fingerprint !== lexical.value.fingerprint) {
    return err("INTERNAL", CONCURRENT_INDEX_CHANGE_MESSAGE);
  }
  const match = await findEphemeralActivationProbeMatch(store, plan.value);
  if (!match.ok) {
    return finish("failed", "connector_probe_unavailable");
  }
  if (match.value.kind !== "matched") {
    return finish("failed", "connector_probe_unavailable");
  }

  const proof = await executeMcpProof({
    command: normalizedTarget.serverEntry.command,
    args: normalizedTarget.serverEntry.args,
    collection,
    term: match.value.value.term,
    expectedUri: match.value.value.resultUri,
    expectedSourceHash: match.value.value.resultSourceHash,
    expectedIndexName: plan.value.identity.indexName,
    timeoutMs: Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const beforePersistence = await revalidateEphemeralActivationProbePlan(
    store,
    plan.value
  );
  if (!beforePersistence.ok) {
    return beforePersistence;
  }
  if (!beforePersistence.value.stable) {
    return err("INTERNAL", CONCURRENT_INDEX_CHANGE_MESSAGE);
  }

  const persisted = proof.ok
    ? await finish("passed")
    : await finish("failed", proof.code);
  if (!persisted.ok) {
    return persisted;
  }
  const afterPersistence = await revalidateEphemeralActivationProbePlan(
    store,
    plan.value
  );
  if (!afterPersistence.ok) {
    return afterPersistence;
  }
  if (afterPersistence.value.stable) {
    return persisted;
  }

  const cleanup = await discardObsoleteConnectorReceipt(
    store,
    collection,
    afterPersistence.value.currentPlan.fingerprint,
    identity
  );
  if (!cleanup.ok) {
    return cleanup;
  }
  return err("INTERNAL", CONCURRENT_INDEX_CHANGE_MESSAGE);
}
