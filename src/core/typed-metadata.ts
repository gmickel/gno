/** Bounded custom metadata and the shared, type-strict retrieval predicate. */
import { z } from "zod";

export type MetadataScalar = string | number | boolean;
export type TypedValue = MetadataScalar | MetadataScalar[];
export type TypedMetadata = Record<string, TypedValue>;
export type MetadataPredicate =
  | { op: "and" | "or"; predicates: MetadataPredicate[] }
  | { op: "not"; predicate: MetadataPredicate }
  | { op: "eq" | "ne"; key: string; value: MetadataScalar }
  | { op: "gt" | "gte" | "lt" | "lte"; key: string; value: number }
  | { op: "in" | "nin" | "all"; key: string; values: MetadataScalar[] }
  | { op: "exists"; key: string; value: boolean };

export const METADATA_COVERAGE_GUIDANCE =
  "Incomplete coverage is not proof of absence or of matching documents. Warnings describe the query scope, not a specific target. Keep requested filters unchanged. If an expected target is known, diagnose it with the same filter; otherwise report the coverage limit without inventing a target or broadening the search.";
export const METADATA_FILTER_DESCRIPTION = `Typed custom metadata predicate; intersects existing scope. ${METADATA_COVERAGE_GUIDANCE}`;

export const TYPED_METADATA_INGEST_VERSION = 7;
export const METADATA_LIMITS = {
  keys: 64,
  keyLength: 128,
  stringLength: 4096,
  members: 128,
  bytes: 65_536,
  nodes: 128,
  depth: 8,
} as const;
const reserved = new Set(["__proto__", "prototype", "constructor"]);
const keySchema = z
  .string()
  .min(1)
  .max(METADATA_LIMITS.keyLength)
  .refine((key) => !reserved.has(key), "Reserved metadata key");
const scalarSchema = z.union([
  z.string().max(METADATA_LIMITS.stringLength),
  z.number().finite(),
  z.boolean(),
]);
const membersSchema = z
  .array(scalarSchema)
  .max(METADATA_LIMITS.members)
  .refine(
    (values) => values.every((value) => typeof value === typeof values[0]),
    "Array members must have one scalar type"
  );
export const typedMetadataSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (
      value &&
      typeof value === "object" &&
      Object.keys(value).some((key) => reserved.has(key))
    ) {
      ctx.addIssue({ code: "custom", message: "Reserved metadata key" });
    }
  })
  .pipe(
    z
      .record(keySchema, z.union([scalarSchema, membersSchema]))
      .refine(
        (value) => Object.keys(value).length <= METADATA_LIMITS.keys,
        "Too many metadata keys"
      )
      .refine(
        (value) =>
          new TextEncoder().encode(JSON.stringify(value)).length <=
          METADATA_LIMITS.bytes,
        "Metadata exceeds 64 KiB"
      )
  );

const leafSchemas = [
  z
    .object({ op: z.enum(["eq", "ne"]), key: keySchema, value: scalarSchema })
    .strict(),
  z
    .object({
      op: z.enum(["gt", "gte", "lt", "lte"]),
      key: keySchema,
      value: z.number().finite(),
    })
    .strict(),
  z
    .object({
      op: z.enum(["in", "nin", "all"]),
      key: keySchema,
      values: membersSchema.refine(
        (v) => v.length > 0,
        "Membership requires values"
      ),
    })
    .strict(),
  z
    .object({ op: z.literal("exists"), key: keySchema, value: z.boolean() })
    .strict(),
] as const;

/** Finite schema recursion rejects deep/cyclic SDK values before descending.
 * Each level shares its child schema; MCP can export the real input contract. */
function predicateAtDepth(depth: number): z.ZodType<MetadataPredicate> {
  if (depth === METADATA_LIMITS.depth)
    return z
      .discriminatedUnion("op", leafSchemas)
      .meta({ id: "gnoMetadataPredicateDepth8" });
  const child = predicateAtDepth(depth + 1);
  return z
    .discriminatedUnion("op", [
      ...leafSchemas,
      z
        .object({
          op: z.enum(["and", "or"]),
          predicates: z.array(child).min(1).max(128),
        })
        .strict(),
      z.object({ op: z.literal("not"), predicate: child }).strict(),
    ])
    .meta({ id: `gnoMetadataPredicateDepth${depth}` });
}

export const metadataPredicateSchema = predicateAtDepth(1).superRefine(
  (input, ctx) => {
    const queue: MetadataPredicate[] = [input];
    let nodes = 0;
    while (queue.length) {
      const node = queue.pop();
      if (!node) break;
      if (++nodes > METADATA_LIMITS.nodes) {
        ctx.addIssue({ code: "custom", message: "Filter exceeds 128 nodes" });
        return;
      }
      if ("predicates" in node) queue.push(...node.predicates);
      if ("predicate" in node) queue.push(node.predicate);
    }
    if (
      new TextEncoder().encode(JSON.stringify(input)).length >
      METADATA_LIMITS.bytes
    ) {
      ctx.addIssue({ code: "custom", message: "Filter exceeds 64 KiB" });
    }
  }
);

export function normalizeMetadataPredicate(input: unknown): MetadataPredicate {
  const predicate = metadataPredicateSchema.parse(input);
  const normalize = (node: MetadataPredicate): MetadataPredicate => {
    if ("predicates" in node) {
      const unique = new Map(
        node.predicates.map((child) => {
          const value = normalize(child);
          return [JSON.stringify(value), value];
        })
      );
      return {
        op: node.op,
        predicates: [...unique.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([, value]) => value),
      };
    }
    if (node.op === "not")
      return { op: "not", predicate: normalize(node.predicate) };
    if ("values" in node)
      return {
        op: node.op,
        key: node.key,
        values: [...new Set(node.values)].sort((a, b) =>
          JSON.stringify(a) < JSON.stringify(b)
            ? -1
            : JSON.stringify(a) > JSON.stringify(b)
              ? 1
              : 0
        ),
      };
    return node;
  };
  return normalize(predicate);
}

export function matchesMetadataPredicate(
  metadata: TypedMetadata,
  predicate: MetadataPredicate
): boolean {
  if (predicate.op === "and")
    return predicate.predicates.every((p) =>
      matchesMetadataPredicate(metadata, p)
    );
  if (predicate.op === "or")
    return predicate.predicates.some((p) =>
      matchesMetadataPredicate(metadata, p)
    );
  if (predicate.op === "not")
    return !matchesMetadataPredicate(metadata, predicate.predicate);
  if (!("key" in predicate)) return false;
  const present = Object.hasOwn(metadata, predicate.key);
  if (predicate.op === "exists") return present === predicate.value;
  if (!present) return false;
  const field = metadata[predicate.key];
  if ("values" in predicate) {
    const values = Array.isArray(field) ? field : [field];
    if (predicate.op === "all")
      return (
        Array.isArray(field) && predicate.values.every((v) => field.includes(v))
      );
    const match = values.some((v) =>
      predicate.values.some((wanted) => wanted === v)
    );
    return predicate.op === "in" ? match : !match;
  }
  if (Array.isArray(field)) return false;
  if (predicate.op === "eq") return field === predicate.value;
  if (predicate.op === "ne")
    return typeof field === typeof predicate.value && field !== predicate.value;
  if (typeof field !== "number" || typeof predicate.value !== "number")
    return false;
  switch (predicate.op) {
    case "gt":
      return field > predicate.value;
    case "gte":
      return field >= predicate.value;
    case "lt":
      return field < predicate.value;
    case "lte":
      return field <= predicate.value;
    default:
      return false;
  }
}
