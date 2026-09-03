/**
 * gno remember / gno recall command implementations.
 *
 * Thin adapters over the transport-neutral memory service: they resolve CLI
 * flags into service inputs, map `MemoryError` codes onto CLI exit codes, and
 * format results. They never touch the store directly and never take the
 * shared write lease (the service owns it).
 *
 * @module src/cli/commands/memory
 */

import type { Collection } from "../../config/types";
import type { EmbeddingPort } from "../../llm/types";
import type { VectorIndexPort } from "../../store/vector/types";

import { getIndexDbPath } from "../../app/constants";
import {
  type MemoryCandidate,
  MemoryError,
  type MemoryErrorCode,
  type MemoryRecallReceipt,
  MemoryService,
  type RecallResult,
  type RememberInput,
  type RememberResult,
} from "../../core/memory";
import { writeLeasePath } from "../../core/write-lease";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { resolveModelUri } from "../../llm/registry";
import { createVectorIndexPort } from "../../store/vector";
import { CliError, type CliErrorCode } from "../errors";
import { initStore } from "./shared";

/** Environment overrides for the identity defaults. */
export const MEMORY_CALLER_ENV = "GNO_MEMORY_CALLER";
export const MEMORY_SESSION_ENV = "GNO_MEMORY_SESSION";

export interface MemoryIdentityCliOptions {
  caller?: string;
  session?: string;
}

export interface MemoryScopeCliOptions {
  configPath?: string;
  indexName?: string;
  collection?: string;
  scopes?: string[];
}

export interface RememberCliOptions
  extends MemoryScopeCliOptions, MemoryIdentityCliOptions {
  text: string;
  /** `--decision add|supersede` (explicit form). */
  decision?: string;
  /** `--add` shorthand for `--decision add`. */
  add?: boolean;
  /** `--supersede <uri>` shorthand for `--decision supersede --predecessor <uri>`. */
  supersede?: string;
  predecessor?: string;
  predecessorHash?: string;
  /** Path to a recall receipt JSON (the recall `--json` output or its `receipt`). */
  receipt?: string;
  derivedFrom?: string[];
  source?: string;
}

export interface RecallCliOptions
  extends MemoryScopeCliOptions, MemoryIdentityCliOptions {
  query: string;
  maxFacts?: number;
  maxTokens?: number;
}

export interface MemoryFormatOptions {
  json?: boolean;
  quiet?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity + flag resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Caller/session identity, defaulted from process context: env overrides
 * first, then the invoking OS user and the parent process id (the shell or
 * agent that ran `gno`). Flags override both.
 */
export function resolveMemoryIdentity(
  options: MemoryIdentityCliOptions,
  env: NodeJS.ProcessEnv = process.env
): { caller: string; session: string } {
  const caller =
    options.caller?.trim() ||
    env[MEMORY_CALLER_ENV]?.trim() ||
    `cli:${env.USER?.trim() || env.USERNAME?.trim() || "unknown"}`;
  const session =
    options.session?.trim() ||
    env[MEMORY_SESSION_ENV]?.trim() ||
    `ppid:${process.ppid}`;
  return { caller, session };
}

function requireScopeFlag(scopes: string[] | undefined): string[] {
  const cleaned = (scopes ?? []).map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    throw new CliError(
      "VALIDATION",
      "--scope is required (repeatable): memory has no implicit global scope. Example: --scope project:gno"
    );
  }
  return cleaned;
}

function resolveCollectionName(
  collections: readonly Collection[],
  requested: string | undefined
): string {
  const name = requested?.trim();
  if (name) return name;
  const managed = collections.filter((c) => c.memoryManaged === true);
  if (managed.length === 1) return managed[0]!.name;
  throw new CliError(
    "VALIDATION",
    managed.length === 0
      ? "--collection is required and must name a memoryManaged collection (none is configured; set memoryManaged: true on a collection in the config)."
      : `--collection is required: ${managed.length} memoryManaged collections are configured (${managed.map((c) => c.name).join(", ")}).`
  );
}

function parsePositiveInt(flag: string, raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliError("VALIDATION", `${flag} must be a positive integer.`, {
      details: { memoryCode: "MEMORY_BUDGET_INVALID" },
    });
  }
  return value;
}

interface ResolvedDecision {
  decision?: "add" | "supersede";
  predecessorUri?: string;
  predecessorHash?: string;
}

function resolveDecision(options: RememberCliOptions): ResolvedDecision {
  const explicit = options.decision?.trim();
  if (explicit && explicit !== "add" && explicit !== "supersede") {
    throw new CliError(
      "VALIDATION",
      "--decision must be add or supersede (omit it to get candidates only)."
    );
  }
  const wantsAdd = Boolean(options.add) || explicit === "add";
  const supersedeUri = options.supersede?.trim() || options.predecessor?.trim();
  const wantsSupersede = Boolean(options.supersede) || explicit === "supersede";
  if (wantsAdd && wantsSupersede) {
    throw new CliError(
      "VALIDATION",
      "--add and --supersede are mutually exclusive; choose one decision."
    );
  }
  if (wantsSupersede) {
    if (!supersedeUri) {
      throw new CliError(
        "VALIDATION",
        "--decision supersede requires --predecessor <gno://uri> (or use --supersede <gno://uri>)."
      );
    }
    const predecessorHash = options.predecessorHash?.trim();
    if (!predecessorHash) {
      throw new CliError(
        "VALIDATION",
        "--supersede requires --predecessor-hash <hash> (the contentHash from recall)."
      );
    }
    return {
      decision: "supersede",
      predecessorUri: supersedeUri,
      predecessorHash,
    };
  }
  if (options.predecessor || options.predecessorHash) {
    throw new CliError(
      "VALIDATION",
      "--predecessor / --predecessor-hash only apply with --supersede or --decision supersede."
    );
  }
  return wantsAdd ? { decision: "add" } : {};
}

async function readReceiptFile(
  path: string | undefined
): Promise<MemoryRecallReceipt | undefined> {
  if (!path) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(path).text());
  } catch (error) {
    throw new CliError(
      "VALIDATION",
      `--receipt must point to a JSON recall receipt: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const candidate =
    parsed && typeof parsed === "object" && "receipt" in parsed
      ? (parsed as { receipt: unknown }).receipt
      : parsed;
  const receipt = candidate as Partial<MemoryRecallReceipt> | null;
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !Array.isArray(receipt.spanHashes) ||
    !Array.isArray(receipt.memoryIds) ||
    typeof receipt.digest !== "string"
  ) {
    throw new CliError(
      "VALIDATION",
      "--receipt file is not a recall receipt (expected the recall --json output or its `receipt` object)."
    );
  }
  return receipt as MemoryRecallReceipt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error mapping
// ─────────────────────────────────────────────────────────────────────────────

const MEMORY_ERROR_TO_CLI: Record<MemoryErrorCode, CliErrorCode> = {
  MEMORY_TEXT_REQUIRED: "VALIDATION",
  MEMORY_TEXT_TOO_LARGE: "VALIDATION",
  MEMORY_QUERY_REQUIRED: "VALIDATION",
  MEMORY_BUDGET_INVALID: "VALIDATION",
  MEMORY_COLLECTION_REQUIRED: "VALIDATION",
  MEMORY_COLLECTION_NOT_FOUND: "VALIDATION",
  MEMORY_COLLECTION_UNMANAGED: "VALIDATION",
  MEMORY_SCOPES_REQUIRED: "VALIDATION",
  MEMORY_SCOPES_INVALID: "VALIDATION",
  MEMORY_IDENTITY_REQUIRED: "VALIDATION",
  MEMORY_DECISION_INVALID: "VALIDATION",
  MEMORY_PREDECESSOR_REQUIRED: "VALIDATION",
  MEMORY_PREDECESSOR_NOT_FOUND: "VALIDATION",
  MEMORY_PREDECESSOR_HASH_MISMATCH: "VALIDATION",
  MEMORY_FENCED_REPLAY: "VALIDATION",
  MEMORY_FENCED_DERIVED: "VALIDATION",
  // Concurrency outcomes: another writer won. Exit 4 like lease contention.
  MEMORY_SUPERSEDE_CONFLICT: "BUSY",
  MEMORY_WRITE_LEASE_BUSY: "BUSY",
  MEMORY_SYNC_FAILED: "RUNTIME",
  MEMORY_SUPERSEDE_PROJECTION_FAILED: "RUNTIME",
  MEMORY_QUERY_FAILED: "RUNTIME",
};

/** Map a core `MemoryError` onto the CLI error model (code carried in details). */
export function toCliError(error: unknown): unknown {
  if (!(error instanceof MemoryError)) return error;
  return new CliError(MEMORY_ERROR_TO_CLI[error.code], error.message, {
    details: { memoryCode: error.code },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Service construction
// ─────────────────────────────────────────────────────────────────────────────

interface MemoryRuntime {
  service: MemoryService;
  collectionName: string;
  close: () => Promise<void>;
}

/**
 * Open the store and build a MemoryService. Semantic matching is attached
 * only when the configured embedding model is already cached (memory
 * commands never download models); otherwise the service runs lexical-only
 * and reports why in `matching` / `retrieval`.
 */
async function openMemoryRuntime(
  options: MemoryScopeCliOptions
): Promise<MemoryRuntime> {
  const storeInit = await initStore({
    configPath: options.configPath,
    indexName: options.indexName,
    syncConfig: true,
  });
  if (!storeInit.ok) {
    throw new CliError("VALIDATION", storeInit.error);
  }
  const { store, config, collections } = storeInit;
  let embedPort: EmbeddingPort | null = null;
  let vectorIndex: VectorIndexPort | null = null;
  const close = async (): Promise<void> => {
    await embedPort?.dispose();
    await store.close();
  };
  try {
    const collectionName = resolveCollectionName(
      collections,
      options.collection
    );
    const modelUri = resolveModelUri(
      config,
      "embed",
      undefined,
      collectionName
    );
    const embedResult = await new LlmAdapter(config).createEmbeddingPort(
      modelUri,
      { egressCollections: [collectionName] }
    );
    if (embedResult.ok) {
      const initResult = await embedResult.value.init();
      if (initResult.ok) {
        embedPort = embedResult.value;
        const vectorResult = await createVectorIndexPort(store.getRawDb(), {
          model: modelUri,
          dimensions: embedPort.dimensions(),
        });
        if (vectorResult.ok) vectorIndex = vectorResult.value;
      } else {
        await embedResult.value.dispose();
      }
    }
    const service = new MemoryService({
      store,
      config,
      collections,
      lockPath: writeLeasePath(getIndexDbPath(options.indexName)),
      embedPort,
      vectorIndex,
    });
    return { service, collectionName, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

export async function remember(
  options: RememberCliOptions
): Promise<RememberResult> {
  const scopes = requireScopeFlag(options.scopes);
  const identity = resolveMemoryIdentity(options);
  const decision = resolveDecision(options);
  const receipt = await readReceiptFile(options.receipt);
  const runtime = await openMemoryRuntime(options);
  try {
    const input: RememberInput = {
      ...identity,
      text: options.text,
      collection: runtime.collectionName,
      scopes,
      ...decision,
      receipt,
      derivedFrom: options.derivedFrom?.length
        ? options.derivedFrom
        : undefined,
      source: options.source,
    };
    return await runtime.service.remember(input);
  } catch (error) {
    throw toCliError(error);
  } finally {
    await runtime.close();
  }
}

export async function recall(options: RecallCliOptions): Promise<RecallResult> {
  const scopes = requireScopeFlag(options.scopes);
  const identity = resolveMemoryIdentity(options);
  const maxFacts = parsePositiveInt("--max-facts", options.maxFacts);
  const maxTokens = parsePositiveInt("--max-tokens", options.maxTokens);
  const runtime = await openMemoryRuntime(options);
  try {
    return await runtime.service.recall({
      ...identity,
      query: options.query,
      collection: runtime.collectionName,
      scopes,
      maxFacts,
      maxTokens,
    });
  } catch (error) {
    throw toCliError(error);
  } finally {
    await runtime.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

function formatMatching(
  matching: RememberResult["matching"] | RecallResult["retrieval"]
): string {
  const note = matching.semanticUnavailable
    ? ` (${matching.semanticUnavailable})`
    : "";
  return `${matching.mode}${note}`;
}

function formatCandidate(candidate: MemoryCandidate): string[] {
  return [
    `  [${candidate.match} ${candidate.similarity.toFixed(2)}] ${candidate.uri}`,
    `    hash: ${candidate.contentHash}`,
    `    ${candidate.text}`,
  ];
}

export function formatRememberResult(
  result: RememberResult,
  options: MemoryFormatOptions = {}
): string {
  if (options.json) return JSON.stringify(result, null, 2);
  if (options.quiet) {
    return result.outcome === "candidates"
      ? result.candidates.map((c) => c.uri).join("\n")
      : result.record.uri;
  }
  const lines: string[] = [];
  if (result.outcome === "candidates") {
    const count = result.candidates.length;
    lines.push(
      count === 0
        ? "No write: no decision given and no candidates in scope. Re-run with --add to store it."
        : `No write: ${count} candidate${count === 1 ? "" : "s"} in scope. Decide with --add (new fact) or --supersede <uri> --predecessor-hash <hash>.`
    );
    for (const candidate of result.candidates) {
      lines.push(...formatCandidate(candidate));
    }
    lines.push(`Matching: ${formatMatching(result.matching)}`);
    return lines.join("\n");
  }
  const { record } = result;
  lines.push(
    result.outcome === "existing"
      ? "Already remembered (exact duplicate, nothing written)."
      : result.outcome === "superseded"
        ? "Remembered fact (supersedes predecessor)."
        : "Remembered fact."
  );
  lines.push(`URI: ${record.uri}`);
  lines.push(`Record: ${record.recordId}`);
  lines.push(`Hash: ${record.contentHash}`);
  lines.push(`Scopes: ${record.scopes.join(", ")}`);
  if (record.supersedes.length > 0) {
    lines.push(`Supersedes: ${record.supersedes.join(", ")}`);
  }
  if (result.outcome !== "existing") {
    lines.push(`Path: ${result.absPath}`);
    lines.push(`Sync: ${result.sync.status}`);
  }
  lines.push(`Matching: ${formatMatching(result.matching)}`);
  return lines.join("\n");
}

export function formatRecallResult(
  result: RecallResult,
  options: MemoryFormatOptions = {}
): string {
  if (options.json) return JSON.stringify(result, null, 2);
  if (options.quiet) {
    return result.facts.length === 0
      ? (result.hint ?? "")
      : result.facts.map((fact) => fact.uri).join("\n");
  }
  const lines: string[] = [];
  if (result.facts.length === 0 && result.hint) {
    lines.push(result.hint);
  }
  for (const [index, fact] of result.facts.entries()) {
    lines.push(`${index + 1}. ${fact.uri}`);
    lines.push(`   ${fact.text}`);
    lines.push(
      `   scopes: ${fact.scopes.join(", ")} | hash: ${fact.contentHash} | by ${fact.caller}/${fact.session} at ${fact.createdAt}`
    );
  }
  const { budget } = result;
  lines.push(
    `Budget: ${result.facts.length}/${budget.maxFacts} facts, ${budget.usedTokens}/${budget.maxTokens} tokens, ${budget.omitted} omitted`
  );
  lines.push(`Retrieval: ${formatMatching(result.retrieval)}`);
  lines.push(`Receipt: ${result.receipt.digest}`);
  return lines.join("\n");
}
