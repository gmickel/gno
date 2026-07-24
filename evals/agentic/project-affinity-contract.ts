import type { LoadedAgenticFixture } from "./fixture-db";
import type { EvidenceCoordinate } from "./types";

import { canonicalFingerprint, sha256Bytes } from "./canonical";
import { AGENTIC_FIXTURE_ROOT } from "./fixture-db";

export interface ProjectAffinityCase {
  caseId: string;
  taskId: string;
  query: string;
  targetCollection: string;
  distractorCollection: string;
  targetDistance: number;
  distractorDistance: number;
  limit: number;
}

export interface ProjectAffinityCasesFixture {
  schemaVersion: "1.0";
  fixtureVersion: string;
  method: "controlled-vector-distance";
  cases: ProjectAffinityCase[];
}

export interface ProjectAffinityIdentityBinding {
  caseId: string;
  taskId: string;
  taskSha256: string;
  oracleSha256: string;
  corpus: Array<{
    collection: string;
    relPath: string;
    sourceHash: string;
  }>;
  requiredEvidence: EvidenceCoordinate[];
}

const CASES_PATH = `${AGENTIC_FIXTURE_ROOT}/project-affinity-cases.json`;

const isHash = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);

function assertCasesFixture(
  value: unknown
): asserts value is ProjectAffinityCasesFixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project-affinity cases fixture must be an object");
  }
  const fixture = value as Record<string, unknown>;
  if (
    fixture.schemaVersion !== "1.0" ||
    typeof fixture.fixtureVersion !== "string" ||
    fixture.method !== "controlled-vector-distance" ||
    !Array.isArray(fixture.cases) ||
    fixture.cases.length !== 2
  ) {
    throw new Error("Invalid project-affinity cases fixture");
  }
  const seen = new Set<string>();
  for (const rawCase of fixture.cases) {
    if (!rawCase || typeof rawCase !== "object" || Array.isArray(rawCase)) {
      throw new Error("Invalid project-affinity case");
    }
    const item = rawCase as Record<string, unknown>;
    if (
      Object.keys(item).sort().join(",") !==
        [
          "caseId",
          "distractorCollection",
          "distractorDistance",
          "limit",
          "query",
          "targetCollection",
          "targetDistance",
          "taskId",
        ]
          .sort()
          .join(",") ||
      typeof item.caseId !== "string" ||
      typeof item.taskId !== "string" ||
      typeof item.query !== "string" ||
      typeof item.targetCollection !== "string" ||
      typeof item.distractorCollection !== "string" ||
      typeof item.targetDistance !== "number" ||
      typeof item.distractorDistance !== "number" ||
      typeof item.limit !== "number" ||
      !Number.isInteger(item.limit) ||
      item.limit < 1 ||
      item.targetDistance <= item.distractorDistance ||
      item.targetDistance - item.distractorDistance >= 0.06
    ) {
      throw new Error("Invalid project-affinity case contract");
    }
    if (seen.has(item.caseId)) {
      throw new Error(`Duplicate project-affinity case: ${item.caseId}`);
    }
    seen.add(item.caseId);
  }
}

export const loadProjectAffinityCases = async (): Promise<{
  fixture: ProjectAffinityCasesFixture;
  fingerprint: string;
}> => {
  const bytes = await Bun.file(CASES_PATH).arrayBuffer();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  assertCasesFixture(parsed);
  return {
    fixture: parsed,
    fingerprint: sha256Bytes(new Uint8Array(bytes)),
  };
};

export const bindProjectAffinityCases = (
  fixture: LoadedAgenticFixture,
  cases: ProjectAffinityCasesFixture
): ProjectAffinityIdentityBinding[] =>
  cases.cases.map((item) => {
    const task = fixture.tasks.get(item.taskId);
    const oracle = fixture.oracles.get(item.taskId);
    if (!(task && oracle)) {
      throw new Error(`Project-affinity case identity missing: ${item.taskId}`);
    }
    if (
      !task.corpus.collections.includes(item.targetCollection) ||
      !task.corpus.collections.includes(item.distractorCollection) ||
      oracle.expectedScope.collection !== item.targetCollection
    ) {
      throw new Error(`Project-affinity case scope mismatch: ${item.caseId}`);
    }
    const requiredEvidence = oracle.claims.flatMap(
      (claim) => claim.requiredEvidence
    );
    if (
      requiredEvidence.length === 0 ||
      requiredEvidence.some(
        (evidence) =>
          !evidence.uri.startsWith(`gno://${item.targetCollection}/`)
      )
    ) {
      throw new Error(
        `Project-affinity case evidence mismatch: ${item.caseId}`
      );
    }
    const taskEntry = fixture.manifest.files.find(
      (entry) => entry.kind === "task" && entry.taskId === item.taskId
    );
    const oracleEntry = fixture.manifest.files.find(
      (entry) => entry.kind === "oracle" && entry.taskId === item.taskId
    );
    if (
      !(taskEntry && oracleEntry) ||
      !isHash(taskEntry.sha256) ||
      !isHash(oracleEntry.sha256)
    ) {
      throw new Error(
        `Project-affinity manifest binding missing: ${item.caseId}`
      );
    }
    return {
      caseId: item.caseId,
      taskId: item.taskId,
      taskSha256: taskEntry.sha256,
      oracleSha256: oracleEntry.sha256,
      corpus: fixture.snapshot.files
        .filter((file) => file.taskId === item.taskId)
        .map((file) => ({
          collection: file.collection,
          relPath: file.relPath,
          sourceHash: file.sourceHash,
        }))
        .sort((left, right) =>
          `${left.collection}/${left.relPath}`.localeCompare(
            `${right.collection}/${right.relPath}`,
            "en"
          )
        ),
      requiredEvidence: structuredClone(requiredEvidence),
    };
  });

export const projectAffinityBindingFingerprint = (
  bindings: readonly ProjectAffinityIdentityBinding[]
): string => canonicalFingerprint(bindings);
