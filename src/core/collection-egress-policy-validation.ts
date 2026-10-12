/** Closed, getter-safe runtime parsing for collection egress policy services. */

import type { EgressPolicy } from "../config/types";
import type {
  CollectionEgressCheckInput,
  EgressRelaxationConfirmation,
} from "./collection-egress-policy-service";

import { EGRESS_POLICIES } from "../config/types";
import { EGRESS_MAX_COLLECTIONS } from "./egress-limits";
import {
  EGRESS_ACTIONS,
  EGRESS_CONTENT_CLASSES,
  EGRESS_DESTINATION_ZONES,
} from "./egress-policy";

const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MAX_COLLECTIONS = EGRESS_MAX_COLLECTIONS;
const POLICIES = new Set<unknown>(EGRESS_POLICIES);
const ACTIONS = new Set<unknown>(EGRESS_ACTIONS);
const DESTINATIONS = new Set<unknown>(EGRESS_DESTINATION_ZONES);
const CONTENT_CLASSES = new Set<unknown>(EGRESS_CONTENT_CLASSES);

export type PolicyValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "VALIDATION"; error: string };

const invalid = <T>(message: string): PolicyValidationResult<T> => ({
  ok: false,
  code: "VALIDATION",
  error: message,
});

/**
 * Snapshot only own data properties. Accessors, exotic prototypes, symbols,
 * proxy traps, arrays, and unknown keys are rejected without invoking getters.
 */
const closedRecord = (
  value: unknown,
  allowedKeys: readonly string[]
): PolicyValidationResult<Record<string, unknown>> => {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return invalid("Expected a JSON object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalid("Expected a plain JSON object");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > allowedKeys.length ||
      keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
    ) {
      return invalid("Object contains unknown fields");
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") return invalid("Invalid object field");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        return invalid("Accessor fields are not allowed");
      }
      result[key] = descriptor.value;
    }
    return { ok: true, value: result };
  } catch {
    return invalid("Unreadable input object");
  }
};

export const parseCollectionName = (
  value: unknown
): PolicyValidationResult<string> =>
  typeof value === "string" && COLLECTION_PATTERN.test(value)
    ? { ok: true, value }
    : invalid("Invalid collection name");

const parsePolicy = (value: unknown): PolicyValidationResult<EgressPolicy> =>
  POLICIES.has(value)
    ? { ok: true, value: value as EgressPolicy }
    : invalid("Invalid collection egress policy");

const parseConfirmation = (
  value: unknown
): PolicyValidationResult<EgressRelaxationConfirmation | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };
  const record = closedRecord(value, [
    "acknowledged",
    "collection",
    "currentPolicy",
    "currentRevision",
    "targetPolicy",
  ]);
  if (!record.ok) return record;
  const collection = parseCollectionName(record.value.collection);
  const currentPolicy = parsePolicy(record.value.currentPolicy);
  const targetPolicy = parsePolicy(record.value.targetPolicy);
  if (
    !collection.ok ||
    !currentPolicy.ok ||
    !targetPolicy.ok ||
    !Number.isSafeInteger(record.value.currentRevision) ||
    (record.value.currentRevision as number) < 0 ||
    record.value.acknowledged !== true
  ) {
    return invalid("Invalid egress relaxation confirmation");
  }
  return {
    ok: true,
    value: {
      acknowledged: true,
      collection: collection.value,
      currentPolicy: currentPolicy.value,
      currentRevision: record.value.currentRevision as number,
      targetPolicy: targetPolicy.value,
    },
  };
};

export const parsePolicySetInput = (
  value: unknown
): PolicyValidationResult<{
  collection: string;
  policy: EgressPolicy;
  confirmation?: EgressRelaxationConfirmation;
}> => {
  const record = closedRecord(value, ["collection", "confirmation", "policy"]);
  if (!record.ok) return record;
  const collection = parseCollectionName(record.value.collection);
  const policy = parsePolicy(record.value.policy);
  const confirmation = parseConfirmation(record.value.confirmation);
  if (!collection.ok || !policy.ok || !confirmation.ok) {
    return invalid("Invalid collection egress policy mutation");
  }
  return {
    ok: true,
    value: {
      collection: collection.value,
      policy: policy.value,
      confirmation: confirmation.value,
    },
  };
};

export const parsePolicySetBody = (
  value: unknown,
  collectionValue: unknown
): PolicyValidationResult<{
  collection: string;
  policy: EgressPolicy;
  confirmation?: EgressRelaxationConfirmation;
}> => {
  const record = closedRecord(value, ["confirmation", "policy"]);
  if (!record.ok) return record;
  return parsePolicySetInput({
    collection: collectionValue,
    confirmation: record.value.confirmation,
    policy: record.value.policy,
  });
};

const parseCollections = (
  value: unknown
): PolicyValidationResult<string[] | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };
  try {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > MAX_COLLECTIONS
    ) {
      return invalid("Invalid collection scope");
    }
    const names: string[] = [];
    const seenNames = new Set<string>();
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) return invalid("Invalid collection scope");
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) {
        return invalid("Invalid collection scope");
      }
      const name = parseCollectionName(descriptor.value);
      if (!name.ok) return invalid("Invalid collection scope");
      if (seenNames.has(name.value)) {
        return invalid("Invalid collection scope");
      }
      seenNames.add(name.value);
      names.push(name.value);
    }
    return { ok: true, value: names };
  } catch {
    return invalid("Unreadable collection scope");
  }
};

export const parsePolicyCheckInput = (
  value: unknown
): PolicyValidationResult<CollectionEgressCheckInput> => {
  const record = closedRecord(value, [
    "action",
    "caller",
    "collections",
    "contentClass",
    "destinationZone",
    "partialResults",
  ]);
  if (!record.ok) return record;
  const caller = closedRecord(record.value.caller, [
    "authenticated",
    "operationAuthorized",
  ]);
  const collections = parseCollections(record.value.collections);
  const partialResults = record.value.partialResults ?? "deny";
  if (
    !caller.ok ||
    !collections.ok ||
    !ACTIONS.has(record.value.action) ||
    !DESTINATIONS.has(record.value.destinationZone) ||
    !CONTENT_CLASSES.has(record.value.contentClass) ||
    (partialResults !== "deny" && partialResults !== "explicit") ||
    typeof caller.value.authenticated !== "boolean" ||
    typeof caller.value.operationAuthorized !== "boolean"
  ) {
    return invalid("Invalid egress policy check");
  }
  return {
    ok: true,
    value: {
      collections: collections.value,
      action: record.value.action as CollectionEgressCheckInput["action"],
      destinationZone: record.value
        .destinationZone as CollectionEgressCheckInput["destinationZone"],
      caller: {
        authenticated: caller.value.authenticated,
        operationAuthorized: caller.value.operationAuthorized,
      },
      contentClass: record.value
        .contentClass as CollectionEgressCheckInput["contentClass"],
      partialResults,
    },
  };
};
