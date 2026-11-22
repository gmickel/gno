/**
 * Lightweight browser-side typed metadata predicate parser and normalizer.
 * Mirrors src/core/typed-metadata.ts validation and canonicalization rules
 * without pulling `zod` into the Web UI bundle.
 */

import type {
  MetadataPredicate,
  MetadataScalar,
} from "../../../core/typed-metadata";

const LIMITS = {
  keyLength: 128,
  stringLength: 4096,
  members: 128,
  bytes: 65_536,
  nodes: 128,
  depth: 8,
} as const;

const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const UTF8_ENCODER = new TextEncoder();

class PredicateValidationError extends Error {
  constructor(
    readonly path: string[],
    message: string
  ) {
    super(message);
  }
}

function fail(path: string[], message: string): never {
  throw new PredicateValidationError(path, message);
}

function assertExactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string[]
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(path, `Unrecognized key: "${key}"`);
    }
  }
}

function validateKey(value: unknown, path: string[]): string {
  if (typeof value !== "string" || value.length < 1) {
    fail([...path, "key"], "Expected non-empty string");
  }
  if (value.length > LIMITS.keyLength) {
    fail([...path, "key"], `Key exceeds ${LIMITS.keyLength} characters`);
  }
  if (RESERVED_KEYS.has(value)) {
    fail([...path, "key"], "Reserved metadata key");
  }
  return value;
}

function validateScalar(value: unknown, path: string[]): MetadataScalar {
  if (typeof value === "string") {
    if (value.length > LIMITS.stringLength) {
      fail(path, `String exceeds ${LIMITS.stringLength} characters`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail(path, "Expected finite number");
    }
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  fail(path, "Expected string, finite number, or boolean");
}

function validatePredicate(
  input: unknown,
  depth: number,
  path: string[],
  counter: { nodes: number }
): MetadataPredicate {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail(path, "Expected predicate object");
  }
  counter.nodes += 1;
  if (counter.nodes > LIMITS.nodes) {
    fail([], `Filter exceeds ${LIMITS.nodes} nodes`);
  }
  const obj = input as Record<string, unknown>;
  const op = obj.op;
  if (typeof op !== "string") {
    fail([...path, "op"], "Missing or invalid operator");
  }

  switch (op) {
    case "eq":
    case "ne": {
      assertExactKeys(obj, ["op", "key", "value"], path);
      return {
        op,
        key: validateKey(obj.key, path),
        value: validateScalar(obj.value, [...path, "value"]),
      };
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      assertExactKeys(obj, ["op", "key", "value"], path);
      if (typeof obj.value !== "number" || !Number.isFinite(obj.value)) {
        fail([...path, "value"], "Expected finite number");
      }
      return {
        op,
        key: validateKey(obj.key, path),
        value: obj.value,
      };
    }
    case "in":
    case "nin":
    case "all": {
      assertExactKeys(obj, ["op", "key", "values"], path);
      const key = validateKey(obj.key, path);
      if (!Array.isArray(obj.values)) {
        fail([...path, "values"], "Expected array of values");
      }
      if (obj.values.length === 0) {
        fail([...path, "values"], "Membership requires values");
      }
      if (obj.values.length > LIMITS.members) {
        fail([...path, "values"], `Array exceeds ${LIMITS.members} items`);
      }
      const scalars: MetadataScalar[] = [];
      let expectedType: string | null = null;
      for (let i = 0; i < obj.values.length; i += 1) {
        const scalar = validateScalar(obj.values[i], [
          ...path,
          "values",
          String(i),
        ]);
        if (expectedType === null) {
          expectedType = typeof scalar;
        } else if (typeof scalar !== expectedType) {
          fail([...path, "values"], "Array members must have one scalar type");
        }
        scalars.push(scalar);
      }
      const uniqueValues = [...new Set(scalars)].sort((a, b) => {
        const sa = JSON.stringify(a);
        const sb = JSON.stringify(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
      return { op, key, values: uniqueValues };
    }
    case "exists": {
      assertExactKeys(obj, ["op", "key", "value"], path);
      if (typeof obj.value !== "boolean") {
        fail([...path, "value"], "Expected boolean");
      }
      return {
        op,
        key: validateKey(obj.key, path),
        value: obj.value,
      };
    }
    case "and":
    case "or": {
      if (depth >= LIMITS.depth) {
        fail(
          [...path, "op"],
          `Maximum predicate depth (${LIMITS.depth}) exceeded`
        );
      }
      assertExactKeys(obj, ["op", "predicates"], path);
      if (!Array.isArray(obj.predicates)) {
        fail([...path, "predicates"], "Expected array of predicates");
      }
      if (obj.predicates.length < 1 || obj.predicates.length > LIMITS.nodes) {
        fail(
          [...path, "predicates"],
          `Expected 1..${LIMITS.nodes} child predicates`
        );
      }
      const unique = new Map<string, MetadataPredicate>();
      for (let i = 0; i < obj.predicates.length; i += 1) {
        const child = validatePredicate(
          obj.predicates[i],
          depth + 1,
          [...path, "predicates", String(i)],
          counter
        );
        unique.set(JSON.stringify(child), child);
      }
      return {
        op,
        predicates: [...unique.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([, value]) => value),
      };
    }
    case "not": {
      if (depth >= LIMITS.depth) {
        fail(
          [...path, "op"],
          `Maximum predicate depth (${LIMITS.depth}) exceeded`
        );
      }
      assertExactKeys(obj, ["op", "predicate"], path);
      return {
        op,
        predicate: validatePredicate(
          obj.predicate,
          depth + 1,
          [...path, "predicate"],
          counter
        ),
      };
    }
    default:
      fail([...path, "op"], `Invalid operator "${op}"`);
  }
}

export function parseMetadataFilter(text: string): {
  filter?: MetadataPredicate;
  error?: string;
} {
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    const normalized = validatePredicate(parsed, 1, [], { nodes: 0 });
    if (UTF8_ENCODER.encode(JSON.stringify(parsed)).length > LIMITS.bytes) {
      fail([], "Filter exceeds 64 KiB");
    }
    return { filter: normalized };
  } catch (error) {
    if (error instanceof PredicateValidationError) {
      const suffix = error.path.length ? `.${error.path.join(".")}` : "";
      return {
        error: `filter${suffix}: ${error.message}. Check the operator, key, and JSON value type.`,
      };
    }
    return {
      error:
        "filter: Invalid JSON. Use quoted strings, finite numbers, booleans, or arrays of one type.",
    };
  }
}
