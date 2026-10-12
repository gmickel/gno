/** Canonical, content-free policy lineage for source and derived artifacts. */

import { z } from "zod";

import type { EgressPolicy, EgressPolicySource } from "../config/types";

import { EgressPolicySchema, EgressPolicySourceSchema } from "../config/types";
import { EGRESS_MAX_COLLECTIONS } from "./egress-limits";

export interface EgressLineageSource {
  collection: string;
  policy: EgressPolicy;
  source: EgressPolicySource;
}

export interface EgressLineage {
  effectivePolicy: EgressPolicy;
  digest: string;
  sources: EgressLineageSource[];
}

export type EgressLineageInput = Readonly<{
  collection: string;
  policy: EgressPolicy;
  source: EgressPolicySource;
}>;

const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_EGRESS_LINEAGE_SOURCES = EGRESS_MAX_COLLECTIONS;
const POLICY_RESTRICTIVENESS: Readonly<Record<EgressPolicy, number>> = {
  local_only: 0,
  lan: 1,
  remote: 2,
};

export class EgressProvenanceError extends Error {
  readonly code: "EMPTY_EGRESS_LINEAGE" | "INVALID_EGRESS_LINEAGE";

  constructor(
    code: "EMPTY_EGRESS_LINEAGE" | "INVALID_EGRESS_LINEAGE",
    message: string
  ) {
    super(message);
    this.name = "EgressProvenanceError";
    this.code = code;
  }
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));
const sha256Text = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const invalidLineageInput = (): EgressProvenanceError =>
  new EgressProvenanceError(
    "INVALID_EGRESS_LINEAGE",
    `Source policy lineage must be a readable dense array with at most ${MAX_EGRESS_LINEAGE_SOURCES} entries`
  );

const snapshotInputs = (
  inputs: readonly EgressLineageInput[]
): readonly EgressLineageInput[] => {
  try {
    if (!Array.isArray(inputs)) throw invalidLineageInput();
    const { length } = inputs;
    if (!Number.isSafeInteger(length) || length > MAX_EGRESS_LINEAGE_SOURCES) {
      throw invalidLineageInput();
    }
    if (length === 0) {
      throw new EgressProvenanceError(
        "EMPTY_EGRESS_LINEAGE",
        "Source policy lineage must contain at least one collection"
      );
    }

    const snapshots: EgressLineageInput[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!(index in inputs)) throw invalidLineageInput();
      const input: unknown = inputs[index];
      if (input === null || typeof input !== "object") {
        throw invalidLineageInput();
      }
      const candidate = input as Partial<EgressLineageInput>;
      snapshots.push({
        collection: candidate.collection as string,
        policy: candidate.policy as EgressPolicy,
        source: candidate.source as EgressPolicySource,
      });
    }
    return snapshots;
  } catch (error) {
    if (error instanceof EgressProvenanceError) throw error;
    throw invalidLineageInput();
  }
};

const canonicalSources = (
  inputs: readonly EgressLineageInput[]
): readonly EgressLineageSource[] => {
  const snapshots = snapshotInputs(inputs);
  const byCollection = new Map<string, EgressLineageSource>();
  for (const input of snapshots) {
    const collectionInput = input.collection;
    const policyInput = input.policy;
    const sourceInput = input.source;
    if (
      typeof collectionInput !== "string" ||
      typeof policyInput !== "string" ||
      typeof sourceInput !== "string"
    ) {
      throw new EgressProvenanceError(
        "INVALID_EGRESS_LINEAGE",
        "Source policy lineage contains an invalid collection or policy"
      );
    }
    const collection = collectionInput.trim().toLowerCase();
    const policy = EgressPolicySchema.safeParse(policyInput);
    const source = EgressPolicySourceSchema.safeParse(sourceInput);
    if (
      collectionInput !== collection ||
      !COLLECTION_PATTERN.test(collection) ||
      !policy.success ||
      !source.success ||
      (source.data !== "explicit" && policy.data !== "local_only")
    ) {
      throw new EgressProvenanceError(
        "INVALID_EGRESS_LINEAGE",
        "Source policy lineage contains an invalid collection or policy"
      );
    }
    const previous = byCollection.get(collection);
    const current = {
      collection,
      policy: policy.data,
      source: source.data,
    };
    if (previous) {
      throw new EgressProvenanceError(
        "INVALID_EGRESS_LINEAGE",
        previous.policy === current.policy && previous.source === current.source
          ? `Duplicate policy lineage for collection ${collection}`
          : `Conflicting policy lineage for collection ${collection}`
      );
    }
    byCollection.set(collection, current);
  }
  return Object.freeze(
    [...byCollection.values()]
      .sort((left, right) =>
        compareCodeUnits(left.collection, right.collection)
      )
      .map((source) => Object.freeze(source))
  );
};

/** Build deterministic lineage. Transformations can aggregate but never relax. */
export const createEgressLineage = (
  inputs: readonly EgressLineageInput[]
): EgressLineage => {
  const sources = canonicalSources(inputs);
  const effectivePolicy = sources.reduce<EgressPolicy>(
    (mostRestrictive, source) =>
      POLICY_RESTRICTIVENESS[source.policy] <
      POLICY_RESTRICTIVENESS[mostRestrictive]
        ? source.policy
        : mostRestrictive,
    "remote"
  );
  const digest = sha256Text(
    canonicalJson({
      effectivePolicy,
      sources: sources.map(({ collection, policy, source }) => ({
        collection,
        policy,
        source,
      })),
    })
  );
  return Object.freeze({ effectivePolicy, digest, sources }) as EgressLineage;
};

/**
 * Canonically merge already-bounded lineage projections. Exact duplicates are
 * collapsed here, before the strict provenance construction boundary.
 */
export const mergeEgressLineages = (
  lineages: readonly Pick<EgressLineage, "sources">[]
): EgressLineage => {
  const byCollection = new Map<string, EgressLineageInput>();
  for (const lineage of lineages) {
    for (const input of lineage.sources) {
      const collection = input.collection;
      const previous = byCollection.get(collection);
      if (
        previous &&
        (previous.policy !== input.policy || previous.source !== input.source)
      ) {
        throw new EgressProvenanceError(
          "INVALID_EGRESS_LINEAGE",
          `Conflicting policy lineage for collection ${collection}`
        );
      }
      if (!previous) byCollection.set(collection, input);
    }
  }
  return createEgressLineage([...byCollection.values()]);
};

/** Resolve an exact requested scope; empty and unknown names fail closed. */
export const resolveEgressLineage = (
  inputs: readonly EgressLineageInput[],
  requestedNames?: readonly string[]
): EgressLineage => {
  const canonical = canonicalSources(inputs);
  if (requestedNames === undefined) return createEgressLineage(canonical);
  let requested: string[];
  try {
    if (!Array.isArray(requestedNames)) throw invalidLineageInput();
    const { length } = requestedNames;
    if (!Number.isSafeInteger(length) || length > MAX_EGRESS_LINEAGE_SOURCES) {
      throw invalidLineageInput();
    }
    const names: string[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!(index in requestedNames)) throw invalidLineageInput();
      const name: unknown = requestedNames[index];
      if (
        typeof name !== "string" ||
        name !== name.trim().toLowerCase() ||
        !COLLECTION_PATTERN.test(name)
      ) {
        throw new EgressProvenanceError(
          "INVALID_EGRESS_LINEAGE",
          "Requested policy scope contains an invalid collection"
        );
      }
      names.push(name);
    }
    requested = [...new Set(names)].sort();
  } catch (error) {
    if (error instanceof EgressProvenanceError) throw error;
    throw new EgressProvenanceError(
      "INVALID_EGRESS_LINEAGE",
      "Requested policy scope must be a readable dense bounded array"
    );
  }
  if (requested.length === 0) {
    throw new EgressProvenanceError(
      "EMPTY_EGRESS_LINEAGE",
      "Requested policy scope must contain at least one collection"
    );
  }
  const byCollection = new Map(
    canonical.map((input) => [input.collection, input])
  );
  const missing = requested.filter((name) => !byCollection.has(name));
  if (missing.length > 0) {
    throw new EgressProvenanceError(
      "INVALID_EGRESS_LINEAGE",
      `Unknown collection policy scope: ${missing.join(", ")}`
    );
  }
  return createEgressLineage(
    requested.map((name) => byCollection.get(name) as EgressLineageInput)
  );
};

/** Conservative lineage for persisted legacy artifacts without provenance. */
export const legacyLocalOnlyEgressLineage = (
  collection = "legacy"
): EgressLineage =>
  createEgressLineage([
    { collection, policy: "local_only", source: "legacy_default" },
  ]);

/** True only for the exact migration projection used by pre-lineage rows. */
export const isMigratedLegacyEgressLineage = (
  lineage: EgressLineage
): boolean => lineage.digest === legacyLocalOnlyEgressLineage().digest;

export const egressLineageByteSize = (lineage: EgressLineage): number =>
  new TextEncoder().encode(canonicalJson(lineage)).byteLength;

export const egressLineageSourceSchema = z
  .object({
    collection: z.string().regex(COLLECTION_PATTERN),
    policy: EgressPolicySchema,
    source: EgressPolicySourceSchema,
  })
  .strict();

export const egressLineageSchema = z
  .object({
    effectivePolicy: EgressPolicySchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    sources: z
      .array(egressLineageSourceSchema)
      .min(1)
      .max(MAX_EGRESS_LINEAGE_SOURCES),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      const canonical = createEgressLineage(value.sources);
      if (
        canonical.effectivePolicy !== value.effectivePolicy ||
        canonical.digest !== value.digest ||
        JSON.stringify(canonical.sources) !== JSON.stringify(value.sources)
      ) {
        context.addIssue({
          code: "custom",
          message: "Egress lineage must be canonical and digest-bound",
        });
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "Invalid egress lineage",
      });
    }
  });
