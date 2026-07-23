import type { ClaimValue, HiddenOracle, NormalizerId } from "./types";

import { canonicalJson } from "./canonical";

export const VERIFIED_ASK_COMPATIBLE_TASK_IDS = [
  "t012ab3c",
  "t0a1b2c3",
  "t123bc4d",
  "t1b2c3d4",
  "t2c3d4e5",
  "t3d4e5f6",
  "t456ef70",
  "t4e5f607",
  "t567f081",
  "t5f60718",
  "t6071829",
  "t6780192",
  "t718293a",
  "t7891a03",
  "t8293a4b",
  "t93a4b5c",
  "ta4b5c6d",
  "tb5c6d7e",
  "tc6d7e8f",
  "td7e8f90",
  "te8f901a",
  "tf901a2b",
] as const;

export const VERIFIED_ASK_EXCLUDED_TASKS = [
  { taskId: "t234cd5e", reason: "expected_missing_evidence" },
  { taskId: "t345de6f", reason: "expected_missing_evidence" },
] as const;

const normalizeScalar = (
  value: string | number | boolean,
  normalizer: NormalizerId
): string | number | boolean => {
  if (typeof value !== "string") return value;
  if (normalizer === "trim-lower-v1") return value.trim().toLowerCase();
  if (normalizer === "identifier-v1")
    return value.trim().toUpperCase().replace(/\s+/g, "");
  if (normalizer === "iso-date-v1") {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp)
      ? value
      : new Date(timestamp).toISOString().slice(0, 10);
  }
  return value;
};

const normalizedValue = (
  value: ClaimValue,
  normalizer: NormalizerId
): unknown => {
  if (value.type !== "string[]")
    return normalizeScalar(value.value, normalizer);
  const values = value.value.map((item) =>
    String(normalizeScalar(item, normalizer))
  );
  return normalizer === "string-set-v1" ? [...values].sort() : values;
};

export const verifiedAskClaimValuesMatch = (
  actual: ClaimValue,
  expected: ClaimValue,
  normalizer: NormalizerId
): boolean =>
  actual.type === expected.type &&
  canonicalJson(normalizedValue(actual, normalizer)) ===
    canonicalJson(normalizedValue(expected, normalizer));

export const encodeVerifiedAskClaim = (
  claimKey: string,
  value: ClaimValue
): string =>
  `claim ${claimKey} value ${encodeURIComponent(canonicalJson(value))}`;

const validClaimValue = (
  value: unknown,
  expectedType: ClaimValue["type"]
): value is ClaimValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "type,value" ||
    record.type !== expectedType
  )
    return false;
  if (expectedType === "number") return typeof record.value === "number";
  if (expectedType === "boolean") return typeof record.value === "boolean";
  if (expectedType === "string[]")
    return (
      Array.isArray(record.value) &&
      record.value.every((item) => typeof item === "string")
    );
  return typeof record.value === "string";
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface ParsedVerifiedAskClaim {
  value: ClaimValue;
  evidenceId: string | null;
}

/** Parse the complete closed benchmark answer grammar; prefixes never count. */
export const parseVerifiedAskClaimAnswer = (
  answer: string,
  lane: "raw_ask" | "verified_ask",
  oracle: HiddenOracle
): ParsedVerifiedAskClaim | null => {
  const expected = oracle.claims[0];
  if (!expected) return null;
  const claim = `claim ${escapeRegex(expected.claimKey)} value `;
  const pattern =
    lane === "raw_ask"
      ? new RegExp(`^${claim}(\\S+) \\[1\\]\\.$`, "u")
      : new RegExp(`^${claim}(\\S+) \\[evidence:([a-f0-9]{64})\\]\\.$`, "u");
  const match = answer.match(pattern);
  if (!match?.[1]) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(match[1]));
    if (!validClaimValue(parsed, expected.expectedValue.type)) return null;
    return { value: parsed, evidenceId: match[2] ?? null };
  } catch {
    return null;
  }
};

export const exactTaskIdSetMatches = (taskIds: readonly string[]): boolean =>
  canonicalJson([...new Set(taskIds)].sort()) ===
  canonicalJson([...VERIFIED_ASK_COMPATIBLE_TASK_IDS]);
