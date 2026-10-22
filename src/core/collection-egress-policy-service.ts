/** Shared collection egress policy management and explanation contract. */

import type { Config, EgressPolicy, EgressPolicySource } from "../config/types";
import type { ApplyConfigResult, MutationResult } from "./config-mutation";
import type {
  EgressAction,
  EgressCallerContext,
  EgressContentClass,
  EgressDecision,
  EgressDestinationZone,
} from "./egress-policy";

import { resolveConfiguredEgressPolicy } from "../config/types";
import { hashTraceCanonical } from "../store/retrieval-trace-codec";
import {
  parseCollectionName,
  parsePolicyCheckInput,
  parsePolicySetInput,
} from "./collection-egress-policy-validation";
import { EgressDeniedError, planCollectionEgress } from "./egress-enforcement";
import { evaluateEgressPolicy } from "./egress-policy";
import {
  EgressProvenanceError,
  resolveEgressLineage,
} from "./egress-provenance";

const POLICY_ORDER: Readonly<Record<EgressPolicy, number>> = {
  local_only: 0,
  lan: 1,
  remote: 2,
};

export interface CollectionEgressPolicyState {
  schemaVersion: "1.0";
  collection: string;
  configuredPolicy: EgressPolicy | null;
  effectivePolicy: EgressPolicy;
  source: Extract<EgressPolicySource, "explicit" | "config_default">;
  revision: number;
  version: string;
}

export interface EgressRelaxationConfirmation {
  collection: string;
  currentPolicy: EgressPolicy;
  currentRevision: number;
  targetPolicy: EgressPolicy;
  acknowledged: true;
}

export interface CollectionEgressPolicySetResult {
  schemaVersion: "1.0";
  previous: CollectionEgressPolicyState;
  current: CollectionEgressPolicyState;
  change: "tightened" | "relaxed" | "source_changed" | "unchanged";
  invalidation: null | {
    policyEpoch: string;
    queuedJobsInvalidated: number;
    sessionsInvalidated: number;
    staleWorkMustRetry: true;
  };
}

export interface CollectionEgressCheckInput {
  collections?: readonly string[];
  action: EgressAction;
  destinationZone: EgressDestinationZone;
  caller: EgressCallerContext;
  contentClass: EgressContentClass;
  partialResults?: "deny" | "explicit";
}

export interface CollectionEgressCheckResult {
  schemaVersion: "1.0";
  mode: "complete" | "partial" | "denied";
  allowedCollections: string[];
  omittedCollections: Array<{
    collection: string;
    reason: EgressDecision["reason"];
  }>;
  disclosure: null | {
    code: "EGRESS_PARTIAL_RESULT";
    omittedCount: number;
    omittedCollections: string[];
  };
  lineage: ReturnType<typeof resolveEgressLineage>;
  decision: EgressDecision;
  remediation: null | {
    code: EgressDecision["reason"];
    message: string;
  };
}

export interface CollectionEgressPolicyServiceDeps {
  getConfig: () => Config;
  mutateConfig?: (
    mutate: (config: Config) => MutationResult<CollectionEgressPolicySetResult>
  ) => Promise<ApplyConfigResult<CollectionEgressPolicySetResult>>;
  onPolicyChanged?: (
    result: CollectionEgressPolicySetResult
  ) =>
    | Promise<NonNullable<CollectionEgressPolicySetResult["invalidation"]>>
    | NonNullable<CollectionEgressPolicySetResult["invalidation"]>;
}

export type CollectionEgressPolicyServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; error: string };

const stateVersion = (input: {
  collection: string;
  effectivePolicy: EgressPolicy;
  source: EgressPolicySource;
  revision: number;
}): string =>
  `egress-policy-v1:${hashTraceCanonical({
    collection: input.collection,
    effectivePolicy: input.effectivePolicy,
    source: input.source,
    revision: input.revision,
  })}`;

export const collectionEgressPolicyEpoch = (config: Config): string =>
  `egress-epoch-v1:${hashTraceCanonical(
    config.collections
      .map((collection) => {
        const effective = resolveConfiguredEgressPolicy(collection);
        return {
          collection: collection.name,
          policy: effective.policy,
          source: effective.source,
          revision: collection.egressPolicyRevision ?? 0,
        };
      })
      .sort((left, right) => left.collection.localeCompare(right.collection))
  )}`;

/** Rebind immutable source membership to current policies at execution time. */
export const currentEgressSources = (
  config: { collections: readonly Config["collections"][number][] },
  collectionNames: readonly string[]
) =>
  collectionNames.map((name) => {
    const collection = config.collections.find(
      (candidate) => candidate.name === name
    );
    const effective = collection
      ? resolveConfiguredEgressPolicy(collection)
      : {
          policy: "local_only" as const,
          source: "legacy_default" as const,
        };
    return {
      collection: name,
      policy: effective.policy,
      source: effective.source,
    };
  });

const policyState = (
  config: Config,
  name: string
): CollectionEgressPolicyState | null => {
  const collection = config.collections.find(
    (candidate) => candidate.name === name.toLowerCase()
  );
  if (!collection) return null;
  const effective = resolveConfiguredEgressPolicy(collection);
  return {
    schemaVersion: "1.0",
    collection: collection.name,
    configuredPolicy: collection.egressPolicy ?? null,
    effectivePolicy: effective.policy,
    source: effective.source,
    revision: collection.egressPolicyRevision ?? 0,
    version: stateVersion({
      collection: collection.name,
      effectivePolicy: effective.policy,
      source: effective.source,
      revision: collection.egressPolicyRevision ?? 0,
    }),
  };
};

const remediationFor = (
  decision: EgressDecision
): CollectionEgressCheckResult["remediation"] => {
  if (decision.allowed) return null;
  const messages: Partial<Record<EgressDecision["reason"], string>> = {
    AUTHENTICATION_REQUIRED:
      "Authenticate the destination without changing collection policy.",
    CALLER_NOT_AUTHORIZED:
      "Authorize this operation separately from collection policy.",
    POLICY_LOCAL_ONLY:
      "Keep the action local or explicitly relax every source collection.",
    POLICY_LAN_ONLY:
      "Use an authenticated LAN destination or explicitly allow remote egress.",
  };
  return {
    code: decision.reason,
    message:
      messages[decision.reason] ??
      "Correct the action, destination, caller, content class, or collection scope.",
  };
};

export class CollectionEgressPolicyService {
  constructor(private readonly deps: CollectionEgressPolicyServiceDeps) {}

  get(
    name: unknown
  ): CollectionEgressPolicyServiceResult<CollectionEgressPolicyState> {
    const parsed = parseCollectionName(name);
    if (!parsed.ok) return parsed;
    const state = policyState(this.deps.getConfig(), parsed.value);
    return state
      ? { ok: true, value: state }
      : {
          ok: false,
          code: "NOT_FOUND",
          error: `Collection not found: ${parsed.value}`,
        };
  }

  async set(
    input: unknown
  ): Promise<
    CollectionEgressPolicyServiceResult<CollectionEgressPolicySetResult>
  > {
    const parsed = parsePolicySetInput(input);
    if (!parsed.ok) return parsed;
    if (!this.deps.mutateConfig) {
      return {
        ok: false,
        code: "READ_ONLY",
        error: "Collection policy mutation is not available",
      };
    }
    const changed = await this.deps.mutateConfig((config) => {
      const previous = policyState(config, parsed.value.collection);
      if (!previous) {
        return {
          ok: false,
          code: "NOT_FOUND",
          error: `Collection not found: ${parsed.value.collection}`,
        };
      }
      const orderDelta =
        POLICY_ORDER[parsed.value.policy] -
        POLICY_ORDER[previous.effectivePolicy];
      const sourceChanged = previous.source !== "explicit";
      const confirmation = parsed.value.confirmation;
      const confirmationMatches =
        confirmation?.acknowledged === true &&
        confirmation.collection === previous.collection &&
        confirmation.currentPolicy === previous.effectivePolicy &&
        confirmation.currentRevision === previous.revision &&
        confirmation.targetPolicy === parsed.value.policy;
      if (
        (confirmation && !confirmationMatches) ||
        (orderDelta > 0 && !confirmationMatches)
      ) {
        return {
          ok: false,
          code: "EGRESS_RELAXATION_CONFIRMATION_REQUIRED",
          error:
            "Relaxing collection egress requires confirmation bound to the current policy revision",
        };
      }
      if (orderDelta === 0 && !sourceChanged) {
        return {
          ok: true,
          config,
          skipSave: true,
          value: {
            schemaVersion: "1.0",
            previous,
            current: previous,
            change: "unchanged",
            invalidation: null,
          },
        };
      }
      if (previous.revision >= Number.MAX_SAFE_INTEGER) {
        return {
          ok: false,
          code: "CONSTRAINT_VIOLATION",
          error: "Collection egress policy revision is exhausted",
        };
      }
      const collections = config.collections.map((collection) =>
        collection.name === previous.collection
          ? {
              ...collection,
              egressPolicy: parsed.value.policy,
              egressPolicyRevision: previous.revision + 1,
            }
          : collection
      );
      const nextConfig = { ...config, collections };
      const current = policyState(nextConfig, previous.collection);
      if (!current) {
        return {
          ok: false,
          code: "NOT_FOUND",
          error: `Collection not found: ${parsed.value.collection}`,
        };
      }
      return {
        ok: true,
        config: nextConfig,
        value: {
          schemaVersion: "1.0",
          previous,
          current,
          change:
            orderDelta > 0
              ? "relaxed"
              : orderDelta < 0
                ? "tightened"
                : "source_changed",
          invalidation: null,
        },
      };
    });
    if (!changed.ok) return changed;
    const value = changed.value;
    if (!value) {
      return {
        ok: false,
        code: "RUNTIME",
        error: "Policy mutation returned no result",
      };
    }
    if (value.change !== "unchanged") {
      const invalidation = await this.deps.onPolicyChanged?.(value);
      value.invalidation = invalidation ?? {
        policyEpoch: collectionEgressPolicyEpoch(changed.config),
        queuedJobsInvalidated: 0,
        sessionsInvalidated: 0,
        staleWorkMustRetry: true,
      };
    }
    return { ok: true, value };
  }

  check(
    input: unknown
  ): CollectionEgressPolicyServiceResult<CollectionEgressCheckResult> {
    const parsed = parsePolicyCheckInput(input);
    if (!parsed.ok) return parsed;
    const config = this.deps.getConfig();
    const names =
      parsed.value.collections ??
      config.collections
        .map(({ name }) => name)
        .sort((a, b) => a.localeCompare(b));
    let deniedLineage: ReturnType<typeof resolveEgressLineage> | null = null;
    let deniedDecision: EgressDecision | null = null;
    try {
      const sources = names.map((name) => {
        const state = policyState(config, name);
        if (!state) {
          return {
            collection: name,
            policy: "local_only" as const,
            source: "legacy_default" as const,
          };
        }
        return {
          collection: state.collection,
          policy: state.effectivePolicy,
          source: state.source,
        };
      });
      const lineage = resolveEgressLineage(sources, names);
      const decision = evaluateEgressPolicy({
        collections: lineage.sources,
        action: parsed.value.action,
        destination: { zone: parsed.value.destinationZone },
        caller: parsed.value.caller,
        contentClass: parsed.value.contentClass,
      });
      deniedLineage = lineage;
      deniedDecision = decision;
      const plan = planCollectionEgress({
        collections: config.collections,
        collectionNames: names,
        action: parsed.value.action,
        destinationZone: parsed.value.destinationZone,
        caller: parsed.value.caller,
        contentClass: parsed.value.contentClass,
        partialResults: parsed.value.partialResults,
      });
      return {
        ok: true,
        value: {
          schemaVersion: "1.0",
          mode: plan.mode,
          allowedCollections: plan.allowedCollections,
          omittedCollections: plan.omittedCollections,
          disclosure: plan.disclosure,
          lineage,
          decision,
          remediation: remediationFor(decision),
        },
      };
    } catch (error) {
      if (error instanceof EgressProvenanceError) {
        return {
          ok: false,
          code: "VALIDATION",
          error:
            error.code === "EGRESS_SCOPE_LIMIT_EXCEEDED"
              ? "Collection egress scope exceeds 128 collections; name the collections to check"
              : "Invalid collection egress scope",
        };
      }
      if (!(error instanceof EgressDeniedError)) throw error;
      if (!deniedLineage || !deniedDecision) throw error;
      const decision = deniedDecision;
      return {
        ok: true,
        value: {
          schemaVersion: "1.0",
          mode: "denied",
          allowedCollections: [],
          omittedCollections: deniedLineage.sources.map(({ collection }) => ({
            collection,
            reason: decision.reason,
          })),
          disclosure: null,
          lineage: deniedLineage,
          decision,
          remediation: remediationFor(decision),
        },
      };
    }
  }

  explain(
    input: unknown
  ): CollectionEgressPolicyServiceResult<CollectionEgressCheckResult> {
    return this.check(input);
  }
}
