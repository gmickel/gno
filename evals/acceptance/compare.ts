import { canonicalJson } from "../agentic/canonical";
import {
  acceptanceManifestFingerprint,
  validateManifestPair,
} from "./manifest";
import {
  acceptanceRecordSchema,
  deterministicRecordFingerprint,
} from "./records";

export interface AcceptanceDifference {
  caseId: string;
  field: string;
  reason: string;
}

export interface AcceptanceComparison {
  passed: boolean;
  comparedCases: number;
  failures: AcceptanceDifference[];
  generatedAnswerChanges: string[];
}

function differences(left: unknown, right: unknown, path: string): string[] {
  if (canonicalJson(left) === canonicalJson(right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const result = left.length === right.length ? [] : [`${path}.length`];
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      result.push(
        ...differences(left[index], right[index], `${path}[${index}]`)
      );
    }
    return result;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
      !(key in a) || !(key in b)
        ? [`${path}.${key}`]
        : differences(a[key], b[key], `${path}.${key}`)
    );
  }
  return [path];
}

/** Identity validation precedes record parsing and comparison. No aggregate
 * score can offset a single unexplained deterministic per-case difference. */
export function compareAcceptance(
  baselineManifest: unknown,
  candidateManifest: unknown,
  baselineRecords: readonly unknown[],
  candidateRecords: readonly unknown[]
): AcceptanceComparison {
  const { baseline, candidate } = validateManifestPair(
    baselineManifest,
    candidateManifest
  );
  const failures: AcceptanceDifference[] = [];
  const generatedAnswerChanges: string[] = [];
  const expectedCases = new Set(baseline.cases.map((item) => item.caseId));
  const sides = [baseline, candidate].map((manifest, side) => {
    const records = (side === 0 ? baselineRecords : candidateRecords).map(
      (value) => acceptanceRecordSchema.parse(value)
    );
    const byCase = new Map<string, (typeof records)[number]>();
    for (const record of records) {
      const fail = (field: string, reason: string) =>
        failures.push({
          caseId: record.caseId,
          field,
          reason: `${manifest.role}: ${reason}`,
        });
      if (!expectedCases.has(record.caseId)) fail("caseId", "Unexpected case");
      if (byCase.has(record.caseId)) fail("caseId", "Duplicate case");
      if (record.manifestSha256 !== acceptanceManifestFingerprint(manifest))
        fail("manifestSha256", "Record does not belong to manifest");
      const state = record.deterministic.semanticState;
      if (state.vectorsUsed !== (state.vectorStatus === "used"))
        fail(
          "deterministic.semanticState.vectorsUsed",
          "Vector success contradicts observed vector stage"
        );
      byCase.set(record.caseId, record);
    }
    return byCase;
  });
  const [before, after] = sides;
  let comparedCases = 0;
  for (const caseId of expectedCases) {
    const a = before?.get(caseId);
    const b = after?.get(caseId);
    if (!(a && b)) {
      failures.push({
        caseId,
        field: "record",
        reason: `Missing ${a ? "candidate" : "baseline"} case`,
      });
      continue;
    }
    comparedCases++;
    const delta = baseline.intendedDeltas.find(
      (item) => item.caseId === caseId
    );
    if (delta) {
      for (const [record, expected, side] of [
        [a, delta.baselineRecordSha256, "baseline"],
        [b, delta.candidateRecordSha256, "candidate"],
      ] as const) {
        if (deterministicRecordFingerprint(record.deterministic) !== expected) {
          failures.push({
            caseId,
            field: "deterministic",
            reason: `${side}: Intended delta differs from complete oracle record`,
          });
        }
      }
    } else {
      for (const field of differences(
        a.deterministic,
        b.deterministic,
        "deterministic"
      )) {
        failures.push({
          caseId,
          field,
          reason: "Unexplained deterministic difference",
        });
      }
    }
    if (a.generatedAnswer !== b.generatedAnswer)
      generatedAnswerChanges.push(caseId);
  }
  return {
    passed: failures.length === 0,
    comparedCases,
    failures,
    generatedAnswerChanges,
  };
}
