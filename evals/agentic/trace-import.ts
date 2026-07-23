/** Deterministic fn-97 fixture projection for local trace qrels. */

import type {
  RetrievalQrelsCase,
  RetrievalQrelsEvidence,
  RetrievalTraceQrelsArtifact,
} from "../../src/core/retrieval-qrels";
import type {
  AgentTask,
  CorpusSnapshot,
  CorpusSnapshotFile,
  EvidenceCoordinate,
  HiddenOracle,
} from "./types";

import {
  canonicalFingerprint,
  sha256Bytes,
  sourceHash,
  spanHash,
} from "./canonical";
import { assertAgenticSchema } from "./validation";

export interface TraceEvidenceResolver {
  resolve(input: {
    uri: string;
    mirrorHash: string;
  }): Promise<{ content: string } | null>;
}

export interface ImportedTraceAgenticFixture {
  tasks: AgentTask[];
  oracles: HiddenOracle[];
  snapshot: CorpusSnapshot;
  unscorableCaseIds: string[];
}

const taskId = (seed: string): string => `t${sha256Bytes(seed).slice(0, 7)}`;
const collectionId = (name: string): string =>
  `c${sha256Bytes(name).slice(0, 3)}`;

const uriParts = (uri: string): { collection: string; relPath: string } => {
  const match = /^gno:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) throw new Error(`Invalid trace evidence URI: ${uri}`);
  return { collection: match[1]!, relPath: match[2]! };
};

const remappedUri = (uri: string): string => {
  const parts = uriParts(uri);
  return `gno://${collectionId(parts.collection)}/${parts.relPath}`;
};

const stableIdentity = (value: {
  sourceHash?: string;
  docid?: string;
  uri?: string;
}): string => value.sourceHash ?? value.docid ?? value.uri ?? "";

const coordinate = async (
  evidence: RetrievalQrelsEvidence,
  resolver: TraceEvidenceResolver
): Promise<{ coordinate: EvidenceCoordinate; content: string }> => {
  const resolved = await resolver.resolve({
    uri: evidence.uri,
    mirrorHash: evidence.mirrorHash,
  });
  if (!resolved)
    throw new Error(`Trace evidence source is missing: ${evidence.uri}`);
  if (sourceHash(resolved.content) !== evidence.mirrorHash) {
    throw new Error(`Trace evidence mirror is stale: ${evidence.uri}`);
  }
  const exactSpanHash = spanHash(
    resolved.content,
    evidence.startLine,
    evidence.endLine
  );
  if (exactSpanHash !== evidence.passageHash) {
    throw new Error(`Trace evidence passage hash mismatch: ${evidence.uri}`);
  }
  return {
    content: resolved.content,
    coordinate: {
      uri: remappedUri(evidence.uri),
      sourceHash: evidence.mirrorHash,
      startLine: evidence.startLine,
      endLine: evidence.endLine,
      spanHash: exactSpanHash,
      sourceHashProvenance: "harness_observed",
      spanHashProvenance: "harness_observed",
    },
  };
};

const primitiveFilters = (
  value: Record<string, unknown>
): Record<string, string | number | boolean> => {
  const output: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      output[key] =
        key === "collection" && typeof item === "string"
          ? collectionId(item)
          : item;
    }
  }
  return output;
};

const taskCollections = (source: RetrievalQrelsCase): string[] => {
  const collections = new Set<string>();
  for (const evidence of source.baseline.ranked) {
    collections.add(collectionId(uriParts(evidence.uri).collection));
  }
  for (const qrel of source.qrels) {
    if (qrel.target.uri) {
      collections.add(collectionId(uriParts(qrel.target.uri).collection));
    }
  }
  if (collections.size === 0) collections.add(collectionId("missing"));
  return [...collections].sort((left, right) => left.localeCompare(right));
};

const agentTask = (
  source: RetrievalQrelsCase,
  id: string,
  claimKey: string,
  valueType: "identifier" | "string[]",
  category: AgentTask["category"]
): AgentTask => ({
  schemaVersion: "1.0",
  taskId: id,
  category,
  brief: {
    goal: source.query.goalText ?? source.query.text,
    instructions: [
      "Return only the declared structured claims or gaps.",
      "Cite exact evidence spans and abstain when required evidence is absent.",
    ],
  },
  claims: [
    {
      claimKey,
      valueType,
      substantive: true,
      required: true,
    },
  ],
  allowedTools: ["search", "get", "multi_get"],
  budgets: { maxAgentCalls: 3, maxModelVisibleBytes: 12_000 },
  corpus: { collections: taskCollections(source) },
});

const snapshotFiles = async (
  source: RetrievalQrelsCase,
  id: string,
  resolver: TraceEvidenceResolver
): Promise<CorpusSnapshotFile[]> => {
  const files = new Map<string, CorpusSnapshotFile>();
  for (const evidence of source.baseline.ranked) {
    const resolved = await coordinate(evidence, resolver);
    const parts = uriParts(evidence.uri);
    const collection = collectionId(parts.collection);
    const key = `${collection}\0${parts.relPath}`;
    const existing = files.get(key);
    if (existing && existing.sourceHash !== evidence.mirrorHash) {
      throw new Error(`Conflicting trace corpus source: ${evidence.uri}`);
    }
    files.set(key, {
      taskId: id,
      collection,
      relPath: parts.relPath,
      sourcePath: `/virtual/gno-agentic/${id}/${collection}/${parts.relPath}`,
      sourceHash: evidence.mirrorHash,
      content: resolved.content,
    });
  }
  return [...files.values()].sort((left, right) =>
    `${left.collection}\0${left.relPath}`.localeCompare(
      `${right.collection}\0${right.relPath}`
    )
  );
};

const positiveFixture = async (
  source: RetrievalQrelsCase,
  resolver: TraceEvidenceResolver
): Promise<{
  task: AgentTask;
  oracle: HiddenOracle;
  files: CorpusSnapshotFile[];
} | null> => {
  const relevant = source.qrels.filter((qrel) => qrel.label === "relevant");
  if (relevant.length === 0) return null;
  const id = taskId(`${source.caseId}\0positive`);
  const requiredEvidence: EvidenceCoordinate[] = [];
  const forbiddenEvidence: EvidenceCoordinate[] = [];
  for (const qrel of source.qrels) {
    if (!qrel.evidence || qrel.label === "missing_expected") continue;
    const mapped = await coordinate(qrel.evidence, resolver);
    if (qrel.label === "relevant") requiredEvidence.push(mapped.coordinate);
    if (qrel.label === "irrelevant") forbiddenEvidence.push(mapped.coordinate);
  }
  const task = agentTask(
    source,
    id,
    "evidenceSet",
    "string[]",
    "multi_document_comparison"
  );
  const oracle: HiddenOracle = {
    schemaVersion: "1.0",
    taskId: id,
    claims: [
      {
        claimKey: "evidenceSet",
        expectedValue: {
          type: "string[]",
          value: relevant.map((qrel) => stableIdentity(qrel.target)).sort(),
        },
        normalizer: { id: "string-set-v1", version: 1 },
        requiredEvidence,
        optionalEvidence: [],
        forbiddenEvidence,
      },
    ],
    expectedMissing: [],
    expectedScope: {
      collection:
        task.corpus.collections.length === 1
          ? task.corpus.collections[0]!
          : null,
      filters: primitiveFilters(source.query.filters),
    },
    completion: {
      expectAbstention: false,
      maxAgentCalls: task.budgets.maxAgentCalls,
      maxModelVisibleBytes: task.budgets.maxModelVisibleBytes,
      failOnUnexpectedEvidence: true,
    },
    leakCanaries: [],
  };
  assertAgenticSchema("agent-task", task);
  assertAgenticSchema("hidden-oracle", oracle);
  return { task, oracle, files: await snapshotFiles(source, id, resolver) };
};

const missingFixtures = async (
  source: RetrievalQrelsCase,
  resolver: TraceEvidenceResolver
): Promise<
  Array<{
    task: AgentTask;
    oracle: HiddenOracle;
    files: CorpusSnapshotFile[];
  }>
> => {
  const fixtures = [];
  for (const qrel of source.qrels.filter(
    (item) => item.label === "missing_expected"
  )) {
    const id = taskId(`${source.caseId}\0missing\0${qrel.qrelId}`);
    const task = agentTask(
      source,
      id,
      "missingEvidence",
      "identifier",
      "missing_evidence"
    );
    const oracle: HiddenOracle = {
      schemaVersion: "1.0",
      taskId: id,
      claims: [],
      expectedMissing: ["missingEvidence"],
      expectedScope: {
        collection:
          task.corpus.collections.length === 1
            ? task.corpus.collections[0]!
            : null,
        filters: primitiveFilters(source.query.filters),
      },
      completion: {
        expectAbstention: true,
        maxAgentCalls: task.budgets.maxAgentCalls,
        maxModelVisibleBytes: task.budgets.maxModelVisibleBytes,
        failOnUnexpectedEvidence: true,
      },
      leakCanaries: [],
    };
    assertAgenticSchema("agent-task", task);
    assertAgenticSchema("hidden-oracle", oracle);
    fixtures.push({
      task,
      oracle,
      files: await snapshotFiles(source, id, resolver),
    });
  }
  return fixtures;
};

export const importTraceQrels = async (
  artifact: RetrievalTraceQrelsArtifact,
  resolver: TraceEvidenceResolver
): Promise<ImportedTraceAgenticFixture> => {
  if (artifact.schemaVersion !== "1.0" || artifact.format !== "qrels") {
    throw new Error("Unsupported retrieval trace qrels artifact");
  }
  const tasks: AgentTask[] = [];
  const oracles: HiddenOracle[] = [];
  const files: CorpusSnapshotFile[] = [];
  const unscorableCaseIds: string[] = [];
  for (const source of artifact.cases) {
    const positive = await positiveFixture(source, resolver);
    if (positive) {
      tasks.push(positive.task);
      oracles.push(positive.oracle);
      files.push(...positive.files);
    } else if (
      source.qrels.some((qrel) => qrel.label === "irrelevant") &&
      !source.qrels.some((qrel) => qrel.label === "missing_expected")
    ) {
      unscorableCaseIds.push(source.caseId);
    }
    for (const missing of await missingFixtures(source, resolver)) {
      tasks.push(missing.task);
      oracles.push(missing.oracle);
      files.push(...missing.files);
    }
  }
  const fingerprint = canonicalFingerprint(
    files.map(({ taskId: id, collection, relPath, sourceHash: hash }) => ({
      taskId: id,
      collection,
      relPath,
      sourceHash: hash,
    }))
  );
  return {
    tasks,
    oracles,
    snapshot: {
      fixtureVersion: `trace-qrels-${sha256Bytes(fingerprint).slice(0, 12)}`,
      fingerprint,
      files,
    } satisfies CorpusSnapshot,
    unscorableCaseIds,
  };
};
