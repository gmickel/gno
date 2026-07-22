/** Shared, passive activation status for CLI, REST, and UI surfaces. */

import type {
  ActivationStageName,
  ActivationStageReceipt,
  ActivationVerificationCode,
  ActivationVerificationReceipt,
  StorePort,
  StoreResult,
} from "../store/types";
import type { EphemeralActivationProbePlan } from "./activation-probe-plan";
import type {
  ConnectorVerificationCode,
  ConnectorVerificationTarget,
} from "./connector-verifier";

import { createEphemeralActivationProbePlan } from "./activation-probe-plan";
import { verifyLexicalActivation } from "./activation-verifier";
import {
  getConnectorActivationReceiptLookup,
  getConnectorVerificationRemediation,
} from "./connector-verifier";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONNECTOR_TARGETS = 16;
const MAX_CONNECTOR_PROJECTIONS = 64;
const CONNECTOR_CODES = new Set<ActivationVerificationCode>([
  "connector_not_configured",
  "connector_probe_unavailable",
  "connector_unsupported_config",
  "connector_start_failed",
  "connector_timeout",
  "connector_missing_tools",
  "connector_status_failed",
  "connector_search_failed",
  "connector_result_mismatch",
  "target_runtime_unverifiable",
]);

export type SemanticAvailabilityCode =
  | "models_missing"
  | "embeddings_pending"
  | "vector_unavailable"
  | "semantic_not_checked";

export interface ActivationRemediation {
  stage: ActivationStageName;
  code: ActivationVerificationCode;
  command: string;
  message: string;
}

export interface ActivationCollectionStatus {
  collection: string;
  ready: boolean;
  generatedAt: string | null;
  stages: Record<ActivationStageName, ActivationStageReceipt>;
  semanticAvailability: {
    status: "pending" | "skipped";
    code: SemanticAvailabilityCode;
    command: string;
  };
  remediation: ActivationRemediation | null;
}

export interface ActivationConnectorStatus {
  collection: string;
  target: string;
  status: ActivationStageReceipt["status"];
  code?: ActivationVerificationCode;
  remediation: string | null;
}

export interface ActivationStatus {
  schemaVersion: "1.0";
  usable: boolean;
  healthy: boolean;
  collections: ActivationCollectionStatus[];
  /** Only fingerprint-current persisted connector receipts may appear here. */
  connectors: ActivationConnectorStatus[];
  connectorProjection: {
    total: number;
    projected: number;
    truncated: boolean;
  };
}

export interface ActivationStatusOptions {
  concurrency?: number;
  semantic?: {
    modelsCached: boolean;
    embeddingBacklog: number;
    /** Omit when the passive caller has not initialized the vector runtime. */
    vectorAvailable?: boolean;
  };
  /** Current target configs, inspected without starting their runtimes. */
  connectorTargets?: readonly ConnectorVerificationTarget[];
  /** Test seam. Production callers use the shipped local lexical verifier. */
  verifyCollection?: (
    store: StorePort,
    collection: string,
    plan?: EphemeralActivationProbePlan
  ) => Promise<StoreResult<ActivationVerificationReceipt>>;
  /** Test seam for proving fingerprint-scoped coalescing with a stub verifier. */
  prepareCollection?: (
    store: StorePort,
    collection: string
  ) => Promise<StoreResult<EphemeralActivationProbePlan>>;
}

interface VerifiedCollection {
  projected: ActivationCollectionStatus;
  receipt: ActivationVerificationReceipt | null;
}

const inflightByStore = new WeakMap<
  StorePort,
  Map<string, Promise<StoreResult<ActivationVerificationReceipt>>>
>();

function pendingStage(
  code: ActivationVerificationCode
): ActivationStageReceipt {
  return {
    status: "pending",
    startedAt: null,
    completedAt: null,
    latencyMs: null,
    code,
  };
}

function failedStage(code: ActivationVerificationCode): ActivationStageReceipt {
  return {
    status: "failed",
    startedAt: null,
    completedAt: null,
    latencyMs: null,
    code,
  };
}

function skippedStage(
  code: ActivationVerificationCode
): ActivationStageReceipt {
  return {
    status: "skipped",
    startedAt: null,
    completedAt: null,
    latencyMs: null,
    code,
  };
}

function failureReceipt(collection: string): ActivationCollectionStatus {
  const code = "index_query_failed" as const;
  return {
    collection,
    ready: false,
    generatedAt: null,
    stages: {
      index: failedStage(code),
      lexical: skippedStage(code),
      semantic: pendingStage("semantic_not_checked"),
      connector: skippedStage("connector_not_requested"),
    },
    semanticAvailability: {
      status: "pending",
      code: "semantic_not_checked",
      command: "gno status",
    },
    remediation: remediationFor(collection, "index", code),
  };
}

function remediationFor(
  collection: string,
  stage: ActivationStageName,
  code: ActivationVerificationCode
): ActivationRemediation {
  const command = `gno index ${collection} --no-embed`;
  const messages: Partial<Record<ActivationVerificationCode, string>> = {
    no_documents:
      "Index at least one supported text document in this collection.",
    no_probe_term:
      "Add searchable text or adjust the collection filters, then reindex.",
    index_query_failed:
      "Repair the local index and rerun the collection-scoped lexical proof.",
    index_out_of_sync:
      "Rebuild this collection's lexical index so its FTS rows match the current mirrors.",
    retrieval_mismatch:
      "Rebuild the collection index so lexical results match the current source.",
  };
  return {
    stage,
    code,
    command,
    message:
      messages[code] ??
      "Repair the collection-scoped lexical proof, then check activation again.",
  };
}

function semanticAvailability(
  options: ActivationStatusOptions["semantic"]
): ActivationCollectionStatus["semanticAvailability"] {
  if (!options) {
    return {
      status: "pending",
      code: "semantic_not_checked",
      command: "gno status",
    };
  }
  if (!options.modelsCached) {
    return {
      status: "pending",
      code: "models_missing",
      command: "gno models pull --embed",
    };
  }
  if (options.embeddingBacklog > 0) {
    return {
      status: "pending",
      code: "embeddings_pending",
      command: "gno embed",
    };
  }
  if (options.vectorAvailable === false) {
    return {
      status: "skipped",
      code: "vector_unavailable",
      command: "gno doctor",
    };
  }
  return {
    status: "pending",
    code: "semantic_not_checked",
    command: "gno status",
  };
}

function projectReceipt(
  receipt: ActivationVerificationReceipt,
  semantic: ActivationCollectionStatus["semanticAvailability"]
): ActivationCollectionStatus {
  const failedStageEntry = (["index", "lexical"] as const).find(
    (stage) => receipt.stages[stage].status !== "passed"
  );
  const failedStageReceipt = failedStageEntry
    ? receipt.stages[failedStageEntry]
    : undefined;
  return {
    collection: receipt.collection,
    ready: receipt.ready,
    generatedAt: receipt.generatedAt,
    stages: receipt.stages,
    semanticAvailability: semantic,
    remediation:
      failedStageEntry && failedStageReceipt?.code
        ? remediationFor(
            receipt.collection,
            failedStageEntry,
            failedStageReceipt.code
          )
        : null,
  };
}

function connectorFallback(
  collection: string,
  target: ConnectorVerificationTarget,
  lexicalReady: boolean
): ActivationConnectorStatus {
  let status: ActivationStageReceipt["status"] = "pending";
  let code: ActivationVerificationCode = "connector_not_requested";
  if (!lexicalReady) {
    status = "skipped";
    code = "connector_probe_unavailable";
  } else if (target.configError) {
    status = "failed";
    code = "connector_unsupported_config";
  } else if (target.kind === "skill") {
    status = "skipped";
    code = target.installed
      ? "target_runtime_unverifiable"
      : "connector_not_configured";
  } else if (!target.configured) {
    status = target.configError ? "failed" : "skipped";
    code = target.configError
      ? "connector_unsupported_config"
      : "connector_not_configured";
  }
  const remediation =
    code === "connector_not_requested"
      ? `Run explicit read-only verification for ${target.id} from Connectors.`
      : connectorRemediation(code, target.id);
  return {
    collection,
    target: target.id,
    status,
    code,
    remediation,
  };
}

function connectorRemediation(
  code: ActivationVerificationCode,
  target: string
): string {
  return CONNECTOR_CODES.has(code)
    ? getConnectorVerificationRemediation(
        code as ConnectorVerificationCode,
        target
      )
    : `Repeat explicit read-only verification for ${target}.`;
}

async function buildConnectorStatuses(
  store: StorePort,
  collections: VerifiedCollection[],
  targets: readonly ConnectorVerificationTarget[]
): Promise<{ items: ActivationConnectorStatus[]; total: number }> {
  const sortedTargets = [...targets].sort((a, b) => a.id.localeCompare(b.id));
  const boundedTargets = sortedTargets.slice(0, MAX_CONNECTOR_TARGETS);
  const allPairs = collections.flatMap((collection) =>
    boundedTargets.map((target) => ({ collection, target }))
  );
  const items = await mapBounded(
    allPairs.slice(0, MAX_CONNECTOR_PROJECTIONS),
    DEFAULT_CONCURRENCY,
    async ({ collection, target }) => {
      const fallback = connectorFallback(
        collection.projected.collection,
        target,
        collection.projected.ready
      );
      if (!collection.receipt || fallback.code !== "connector_not_requested") {
        return fallback;
      }
      const lookup = getConnectorActivationReceiptLookup(
        collection.receipt.fingerprint,
        target
      );
      const cached = await store.getActivationReceipt(
        collection.projected.collection,
        lookup.fingerprint,
        lookup.connectorTarget
      );
      if (!cached.ok || !cached.value) {
        return fallback;
      }
      const stage = cached.value.stages.connector;
      const code = stage.code;
      return {
        collection: collection.projected.collection,
        target: target.id,
        status: stage.status,
        ...(code ? { code } : {}),
        remediation:
          code && code !== "connector_not_requested"
            ? connectorRemediation(code, target.id)
            : null,
      };
    }
  );
  return { items, total: collections.length * sortedTargets.length };
}

async function verifyCoalesced(
  store: StorePort,
  collection: string,
  fingerprint: string,
  verifyCollection: NonNullable<ActivationStatusOptions["verifyCollection"]>
): Promise<StoreResult<ActivationVerificationReceipt>> {
  let storeInflight = inflightByStore.get(store);
  if (!storeInflight) {
    storeInflight = new Map();
    inflightByStore.set(store, storeInflight);
  }
  const key = `${collection}\0${fingerprint}`;
  const existing = storeInflight.get(key);
  if (existing) {
    return existing;
  }
  const verification = verifyCollection(store, collection);
  storeInflight.set(key, verification);
  try {
    return await verification;
  } finally {
    if (storeInflight.get(key) === verification) {
      storeInflight.delete(key);
    }
  }
}

async function mapBounded<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        const value = values[index];
        if (value !== undefined) {
          results[index] = await mapper(value);
        }
      }
    }
  );
  await Promise.all(workers);
  return results;
}

/**
 * Build deterministic activation status without loading models, starting a
 * connector, making a remote call, or retaining a settled cache.
 */
export async function buildActivationStatus(
  store: StorePort,
  configuredCollections: readonly string[],
  options: ActivationStatusOptions = {}
): Promise<ActivationStatus> {
  const collections = [...new Set(configuredCollections)].sort((a, b) =>
    a.localeCompare(b)
  );
  const verifyCollection = options.verifyCollection;
  const prepareCollection =
    options.prepareCollection ??
    (verifyCollection
      ? null
      : (targetStore: StorePort, collection: string) =>
          createEphemeralActivationProbePlan(targetStore, collection, {
            collectCandidates: false,
          }));
  const semantic = semanticAvailability(options.semantic);
  const verified = await mapBounded(
    collections,
    Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY)),
    async (collection) => {
      try {
        if (!prepareCollection && verifyCollection) {
          const receipt = await verifyCoalesced(
            store,
            collection,
            collection,
            verifyCollection
          );
          return receipt.ok
            ? {
                projected: projectReceipt(receipt.value, semantic),
                receipt: receipt.value,
              }
            : { projected: failureReceipt(collection), receipt: null };
        }
        if (!prepareCollection) {
          return { projected: failureReceipt(collection), receipt: null };
        }
        const prepared = await prepareCollection(store, collection);
        if (!prepared.ok) {
          return { projected: failureReceipt(collection), receipt: null };
        }
        const runVerification = verifyCollection
          ? (targetStore: StorePort, targetCollection: string) =>
              verifyCollection(targetStore, targetCollection, prepared.value)
          : (targetStore: StorePort, targetCollection: string) =>
              verifyLexicalActivation(targetStore, targetCollection, {
                plan: prepared.value,
              });
        const receipt = await verifyCoalesced(
          store,
          collection,
          prepared.value.fingerprint,
          runVerification
        );
        return receipt.ok
          ? {
              projected: projectReceipt(receipt.value, semantic),
              receipt: receipt.value,
            }
          : { projected: failureReceipt(collection), receipt: null };
      } catch {
        return { projected: failureReceipt(collection), receipt: null };
      }
    }
  );
  const projected = verified.map(({ projected: collection }) => collection);
  const connectorStatuses = await buildConnectorStatuses(
    store,
    verified,
    options.connectorTargets ?? []
  );

  return {
    schemaVersion: "1.0",
    usable: projected.some((collection) => collection.ready),
    healthy:
      projected.length > 0 && projected.every((collection) => collection.ready),
    collections: projected,
    connectors: connectorStatuses.items,
    connectorProjection: {
      total: connectorStatuses.total,
      projected: connectorStatuses.items.length,
      truncated: connectorStatuses.total > connectorStatuses.items.length,
    },
  };
}
