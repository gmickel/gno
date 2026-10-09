import {
  EGRESS_POLICIES,
  EGRESS_POLICY_SOURCES,
  type EgressPolicy,
  type EgressPolicySource,
} from "../config/types";
import { EGRESS_MAX_COLLECTIONS } from "./egress-limits";

export { EGRESS_MAX_COLLECTIONS };

export const EGRESS_ACTIONS = [
  "retrieve",
  "serve",
  "publish",
  "remote_inference",
  "export",
  "clip_write",
] as const;
export type EgressAction = (typeof EGRESS_ACTIONS)[number];

export const EGRESS_DESTINATION_ZONES = [
  "local_process",
  "loopback",
  "lan",
  "remote",
] as const;
export type EgressDestinationZone = (typeof EGRESS_DESTINATION_ZONES)[number];

/**
 * Source and derived classes retain the same collection-owned policy.
 * Transformation never declassifies indexed content.
 */
export const EGRESS_CONTENT_CLASSES = [
  "source",
  "snippet",
  "metadata",
  "attachment",
  "embedding",
  "capsule",
  "audit_log",
  "retrieval_trace",
] as const;
export type EgressContentClass = (typeof EGRESS_CONTENT_CLASSES)[number];

export const EGRESS_REASON_CODES = [
  "LOCAL_DESTINATION",
  "LAN_POLICY_AUTHENTICATED",
  "REMOTE_POLICY_AUTHENTICATED",
  "INVALID_INPUT",
  "NO_COLLECTION_POLICY",
  "COLLECTION_LIMIT_EXCEEDED",
  "INVALID_COLLECTION",
  "UNKNOWN_ACTION",
  "UNKNOWN_DESTINATION",
  "ACTION_DESTINATION_MISMATCH",
  "UNKNOWN_CONTENT_CLASS",
  "UNKNOWN_POLICY",
  "UNKNOWN_POLICY_SOURCE",
  "INVALID_POLICY_SOURCE_PAIR",
  "INVALID_CALLER",
  "CALLER_NOT_AUTHORIZED",
  "AUTHENTICATION_REQUIRED",
  "POLICY_LOCAL_ONLY",
  "POLICY_LAN_ONLY",
] as const;
export type EgressReasonCode = (typeof EGRESS_REASON_CODES)[number];

export interface CollectionEgressState {
  /** Stable configured collection identifier; never a filesystem path. */
  collection: string;
  policy: EgressPolicy;
  source: EgressPolicySource;
}

export interface EgressCallerContext {
  /**
   * Transport or feature authentication succeeded. Network destinations
   * always require this; policy cannot make authentication optional.
   */
  authenticated: boolean;
  /**
   * The surrounding authorization layer permits this operation. A false value
   * narrows access even for a policy that would otherwise allow it.
   */
  operationAuthorized: boolean;
}

export interface EgressDestination {
  zone: EgressDestinationZone;
  /**
   * Optional classifier inputs are deliberately excluded from decisions and
   * audit metadata so hosts, provider names, and credentials cannot leak.
   */
  host?: string;
  provider?: string;
}

export interface EgressEvaluationInput {
  collections: readonly CollectionEgressState[];
  action: EgressAction;
  destination: EgressDestination;
  caller: EgressCallerContext;
  contentClass: EgressContentClass;
}

export interface EgressDecisionMetadata {
  action: EgressAction | "unknown";
  destinationZone: EgressDestinationZone | "unknown";
  contentClass: EgressContentClass | "unknown";
  collectionCount: number;
  collections: readonly string[];
  effectivePolicy: EgressPolicy | "unknown";
  effectivePolicySource: EgressPolicySource | "mixed" | "unknown";
  callerAuthenticated: boolean | null;
  callerOperationAuthorized: boolean | null;
}

export interface EgressDecision {
  allowed: boolean;
  code: "EGRESS_ALLOWED" | "EGRESS_DENIED";
  reason: EgressReasonCode;
  audit: EgressDecisionMetadata;
}

export interface EgressPolicyPort {
  evaluate(input: EgressEvaluationInput): EgressDecision;
}

interface RuntimeCollectionEgressState {
  collection: unknown;
  policy: unknown;
  source: unknown;
}

interface EgressEvaluationSnapshot {
  collections: RuntimeCollectionEgressState[];
  action: unknown;
  destinationZone: unknown;
  callerAuthenticated: unknown;
  callerOperationAuthorized: unknown;
  contentClass: unknown;
}

type EgressSnapshotResult =
  | { kind: "invalid" }
  | { kind: "limit_exceeded" }
  | { kind: "snapshot"; value: EgressEvaluationSnapshot };

const ACTIONS = new Set<unknown>(EGRESS_ACTIONS);
const DESTINATION_ZONES = new Set<unknown>(EGRESS_DESTINATION_ZONES);
const CONTENT_CLASSES = new Set<unknown>(EGRESS_CONTENT_CLASSES);
const POLICIES = new Set<unknown>(EGRESS_POLICIES);
const POLICY_SOURCES = new Set<unknown>(EGRESS_POLICY_SOURCES);
const COLLECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const POLICY_ORDER: Record<EgressPolicy, number> = {
  local_only: 0,
  lan: 1,
  remote: 2,
};

const isAction = (value: unknown): value is EgressAction => ACTIONS.has(value);
const isDestinationZone = (value: unknown): value is EgressDestinationZone =>
  DESTINATION_ZONES.has(value);
const isContentClass = (value: unknown): value is EgressContentClass =>
  CONTENT_CLASSES.has(value);
const isPolicy = (value: unknown): value is EgressPolicy => POLICIES.has(value);
const isPolicySource = (value: unknown): value is EgressPolicySource =>
  POLICY_SOURCES.has(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function invalidInputAudit(): EgressDecisionMetadata {
  return {
    action: "unknown",
    destinationZone: "unknown",
    contentClass: "unknown",
    collectionCount: 0,
    collections: [],
    effectivePolicy: "unknown",
    effectivePolicySource: "unknown",
    callerAuthenticated: null,
    callerOperationAuthorized: null,
  };
}

function limitExceededAudit(): EgressDecisionMetadata {
  return {
    ...invalidInputAudit(),
    collectionCount: EGRESS_MAX_COLLECTIONS + 1,
  };
}

/**
 * Read untrusted object graphs once into bounded plain data. Any throwing
 * getter or revoked proxy escapes to the evaluator's fixed fail-closed catch.
 */
function snapshotInput(input: unknown): EgressSnapshotResult {
  if (!isRecord(input)) return { kind: "invalid" };

  const rawCollections = input.collections;
  if (!Array.isArray(rawCollections)) return { kind: "invalid" };
  const collectionCount = rawCollections.length;
  if (collectionCount > EGRESS_MAX_COLLECTIONS) {
    return { kind: "limit_exceeded" };
  }

  const collections: RuntimeCollectionEgressState[] = [];
  for (let index = 0; index < collectionCount; index += 1) {
    const collection = rawCollections[index];
    if (!isRecord(collection)) {
      collections.push({
        collection: undefined,
        policy: undefined,
        source: undefined,
      });
      continue;
    }
    collections.push({
      collection: collection.collection,
      policy: collection.policy,
      source: collection.source,
    });
  }

  const destination = input.destination;
  const caller = input.caller;
  return {
    kind: "snapshot",
    value: {
      collections,
      action: input.action,
      destinationZone: isRecord(destination) ? destination.zone : undefined,
      callerAuthenticated: isRecord(caller) ? caller.authenticated : undefined,
      callerOperationAuthorized: isRecord(caller)
        ? caller.operationAuthorized
        : undefined,
      contentClass: input.contentClass,
    },
  };
}

function snapshotAudit(
  snapshot: EgressEvaluationSnapshot
): EgressDecisionMetadata {
  const collections = snapshot.collections
    .map(({ collection }) =>
      typeof collection === "string" && COLLECTION_NAME_PATTERN.test(collection)
        ? collection
        : "unknown"
    )
    .sort();
  return {
    action: isAction(snapshot.action) ? snapshot.action : "unknown",
    destinationZone: isDestinationZone(snapshot.destinationZone)
      ? snapshot.destinationZone
      : "unknown",
    contentClass: isContentClass(snapshot.contentClass)
      ? snapshot.contentClass
      : "unknown",
    collectionCount: snapshot.collections.length,
    collections,
    effectivePolicy: "unknown",
    effectivePolicySource: "unknown",
    callerAuthenticated:
      typeof snapshot.callerAuthenticated === "boolean"
        ? snapshot.callerAuthenticated
        : null,
    callerOperationAuthorized:
      typeof snapshot.callerOperationAuthorized === "boolean"
        ? snapshot.callerOperationAuthorized
        : null,
  };
}

function decision(
  allowed: boolean,
  reason: EgressReasonCode,
  audit: EgressDecisionMetadata
): EgressDecision {
  return {
    allowed,
    code: allowed ? "EGRESS_ALLOWED" : "EGRESS_DENIED",
    reason,
    audit,
  };
}

function effectiveCollectionPolicy(
  collections: readonly CollectionEgressState[]
): {
  policy: EgressPolicy;
  source: EgressPolicySource | "mixed";
} {
  let policy: EgressPolicy = "remote";
  for (const collection of collections) {
    if (POLICY_ORDER[collection.policy] < POLICY_ORDER[policy]) {
      policy = collection.policy;
    }
  }

  const restrictiveSources = new Set(
    collections
      .filter((collection) => collection.policy === policy)
      .map((collection) => collection.source)
  );
  const source =
    restrictiveSources.size === 1
      ? (restrictiveSources.values().next().value ?? "mixed")
      : "mixed";
  return { policy, source };
}

function actionAllowsDestination(
  action: EgressAction,
  destination: EgressDestinationZone
): boolean {
  switch (action) {
    case "publish":
      return destination === "remote";
    case "remote_inference":
      return destination !== "local_process";
    case "serve":
      return destination !== "local_process";
    case "export":
      return destination !== "loopback";
    case "retrieve":
    case "clip_write":
      return true;
  }
}

/**
 * Evaluate one content-transfer boundary. Runtime guards intentionally accept
 * malformed JavaScript callers fail-closed even though TypeScript callers get
 * the narrower contract.
 */
function evaluateSnapshot(snapshot: EgressEvaluationSnapshot): EgressDecision {
  const audit = snapshotAudit(snapshot);
  if (snapshot.collections.length === 0) {
    return decision(false, "NO_COLLECTION_POLICY", audit);
  }
  if (!isAction(snapshot.action)) {
    return decision(false, "UNKNOWN_ACTION", audit);
  }
  if (!isDestinationZone(snapshot.destinationZone)) {
    return decision(false, "UNKNOWN_DESTINATION", audit);
  }
  if (!actionAllowsDestination(snapshot.action, snapshot.destinationZone)) {
    return decision(false, "ACTION_DESTINATION_MISMATCH", audit);
  }
  if (!isContentClass(snapshot.contentClass)) {
    return decision(false, "UNKNOWN_CONTENT_CLASS", audit);
  }
  if (
    typeof snapshot.callerAuthenticated !== "boolean" ||
    typeof snapshot.callerOperationAuthorized !== "boolean"
  ) {
    return decision(false, "INVALID_CALLER", audit);
  }

  const collections: CollectionEgressState[] = [];
  const collectionNames = new Set<string>();
  for (const collection of snapshot.collections) {
    if (
      typeof collection.collection !== "string" ||
      !COLLECTION_NAME_PATTERN.test(collection.collection)
    ) {
      return decision(false, "INVALID_COLLECTION", audit);
    }
    if (!isPolicy(collection.policy)) {
      return decision(false, "UNKNOWN_POLICY", audit);
    }
    if (!isPolicySource(collection.source)) {
      return decision(false, "UNKNOWN_POLICY_SOURCE", audit);
    }
    if (
      collection.source !== "explicit" &&
      collection.policy !== "local_only"
    ) {
      return decision(false, "INVALID_POLICY_SOURCE_PAIR", audit);
    }
    if (collectionNames.has(collection.collection)) {
      return decision(false, "INVALID_COLLECTION", audit);
    }
    collectionNames.add(collection.collection);
    collections.push({
      collection: collection.collection,
      policy: collection.policy,
      source: collection.source,
    });
  }

  const effective = effectiveCollectionPolicy(collections);
  audit.effectivePolicy = effective.policy;
  audit.effectivePolicySource = effective.source;

  if (!snapshot.callerOperationAuthorized) {
    return decision(false, "CALLER_NOT_AUTHORIZED", audit);
  }
  if (
    snapshot.destinationZone === "local_process" ||
    snapshot.destinationZone === "loopback"
  ) {
    return decision(true, "LOCAL_DESTINATION", audit);
  }
  if (effective.policy === "local_only") {
    return decision(false, "POLICY_LOCAL_ONLY", audit);
  }
  if (snapshot.destinationZone === "remote" && effective.policy === "lan") {
    return decision(false, "POLICY_LAN_ONLY", audit);
  }
  if (!snapshot.callerAuthenticated) {
    return decision(false, "AUTHENTICATION_REQUIRED", audit);
  }
  if (snapshot.destinationZone === "lan") {
    return decision(true, "LAN_POLICY_AUTHENTICATED", audit);
  }
  return decision(true, "REMOTE_POLICY_AUTHENTICATED", audit);
}

/**
 * The fixed, content-free denial for a scope above `EGRESS_MAX_COLLECTIONS`.
 * Boundaries that size a scope before resolving it use this so an oversized
 * configuration is refused as a policy decision, never as a server error.
 */
export function collectionLimitExceededDecision(): EgressDecision {
  return decision(false, "COLLECTION_LIMIT_EXCEEDED", limitExceededAudit());
}

export function evaluateEgressPolicy(input: unknown): EgressDecision {
  try {
    const result = snapshotInput(input);
    if (result.kind === "invalid") {
      return decision(false, "INVALID_INPUT", invalidInputAudit());
    }
    if (result.kind === "limit_exceeded") {
      return collectionLimitExceededDecision();
    }
    return evaluateSnapshot(result.value);
  } catch {
    return decision(false, "INVALID_INPUT", invalidInputAudit());
  }
}

export const defaultEgressPolicyPort: EgressPolicyPort = Object.freeze({
  evaluate: evaluateEgressPolicy,
});
