import type { Config } from "../../src/config/types";
import type { ProjectAffinityScoringInput } from "../../src/pipeline/project-affinity";
import type { SearchResults } from "../../src/pipeline/types";
import type { StorePort } from "../../src/store/types";
import type {
  VectorIndexPort,
  VectorSearchResult,
} from "../../src/store/vector/types";
import type { LoadedAgenticFixture } from "./fixture-db";
import type {
  ProjectAffinityRankedEntry,
  ProjectAffinityStoreCallMap,
  ProjectAffinityStoreCallName,
} from "./project-affinity-promotion";

import { DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import { getProjectAffinityMetadata } from "../../src/pipeline/project-affinity";
import { searchVectorWithEmbedding } from "../../src/pipeline/vsearch";
import { canonicalJson } from "./canonical";
import { PROJECT_AFFINITY_STORE_CALL_LIMITS } from "./project-affinity-promotion";

export interface CallObservation {
  calls: ProjectAffinityStoreCallMap;
  unexpectedCalls: Record<string, number>;
  candidateCount: number;
  requestedCount: number;
  outputLimit: number;
}

export interface SearchRun {
  output: SearchResults;
  observation: CallObservation;
}

const instrumentStore = (
  store: StorePort,
  observation: Pick<CallObservation, "calls" | "unexpectedCalls">
): StorePort =>
  new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const name = String(property);
        if (name in PROJECT_AFFINITY_STORE_CALL_LIMITS) {
          const callName = name as ProjectAffinityStoreCallName;
          observation.calls[callName] += 1;
        } else {
          observation.unexpectedCalls[name] =
            (observation.unexpectedCalls[name] ?? 0) + 1;
        }
        return Reflect.apply(value, target, args);
      };
    },
  });

const emptyStoreCallMap = (): ProjectAffinityStoreCallMap => ({
  getChunksBatch: 0,
  getCollections: 0,
  getContextGeneration: 0,
  getContexts: 0,
  getDocumentsByMirrorHashes: 0,
  getTagsBatch: 0,
  listDocuments: 0,
});

const vectorIndex = (
  candidates: readonly VectorSearchResult[],
  observation: CallObservation
): VectorIndexPort =>
  ({
    searchAvailable: true,
    model: "fixture:project-affinity-vector-v1",
    dimensions: 1,
    vecDirty: false,
    async searchNearest(_embedding, requested) {
      observation.requestedCount = requested;
      const value = candidates.slice(0, requested);
      observation.candidateCount = value.length;
      return { ok: true as const, value };
    },
  }) as VectorIndexPort;

export const projectAffinityEvalConfig = (
  fixture: LoadedAgenticFixture,
  rootPath: string
): Config => ({
  version: "1.0",
  ftsTokenizer: DEFAULT_FTS_TOKENIZER,
  collections: [
    ...new Set(fixture.snapshot.files.map((file) => file.collection)),
  ]
    .sort()
    .map((name) => ({
      name,
      path: `${rootPath}/corpus-snapshot/${fixture.snapshot.files.find((file) => file.collection === name)!.taskId}/${name}`,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    })),
  contexts: [],
  contentTypes: [],
  projectAffinity: { enabled: true, contribution: 0.03 },
});

export const projectAffinityEntries = (
  output: SearchResults
): ProjectAffinityRankedEntry[] => {
  const stableNumber = (value: number): number => Number(value.toFixed(12));
  return output.results.map((result, index) => {
    const affinity = getProjectAffinityMetadata(result);
    return {
      rank: index + 1,
      uri: result.uri,
      score: stableNumber(result.score),
      baseScore: stableNumber(affinity?.baseScore ?? result.score),
      matched: affinity?.matched ?? false,
      affinityRequested: stableNumber(affinity?.affinityRequested ?? 0),
      affinityApplied: stableNumber(affinity?.affinityApplied ?? 0),
      collectionAlias: affinity?.collectionAlias ?? null,
      rootAlias: affinity?.rootAlias ?? null,
    };
  });
};

export const runProjectAffinitySearch = async (
  store: StorePort,
  config: Config,
  query: string,
  candidates: readonly VectorSearchResult[],
  options: {
    affinity?: ProjectAffinityScoringInput;
    collection?: string;
    limit: number;
  }
): Promise<SearchRun> => {
  const observation: CallObservation = {
    calls: emptyStoreCallMap(),
    unexpectedCalls: {},
    candidateCount: 0,
    requestedCount: 0,
    outputLimit: options.limit,
  };
  const result = await searchVectorWithEmbedding(
    {
      store: instrumentStore(store, observation),
      vectorIndex: vectorIndex(candidates, observation),
      embedPort: {} as never,
      config,
    },
    query,
    new Float32Array([1]),
    {
      collection: options.collection,
      limit: options.limit,
      projectAffinity: options.affinity,
    }
  );
  if (!result.ok)
    throw new Error(`Project-affinity eval: ${result.error.message}`);
  return { output: result.value, observation };
};

export const requiredEvidenceRetained = (
  output: SearchResults,
  requiredEvidence: readonly {
    uri: string;
    startLine: number;
    endLine: number;
    sourceHash: string;
  }[]
): boolean =>
  requiredEvidence.every((evidence) =>
    output.results.some(
      (result) =>
        result.uri === evidence.uri &&
        result.source.sourceHash === evidence.sourceHash &&
        (result.snippetRange?.startLine ?? result.line ?? 0) <=
          evidence.startLine &&
        (result.snippetRange?.endLine ?? result.line ?? 0) >= evidence.endLine
    )
  );

export const exactSearchProjection = (output: SearchResults): string =>
  canonicalJson({
    results: output.results.map((result) => ({
      uri: result.uri,
      score: result.score,
      range: result.snippetRange,
      sourceHash: result.source.sourceHash,
    })),
    meta: JSON.parse(JSON.stringify(output.meta)) as unknown,
  });

export const isStructurallyBounded = (observation: CallObservation): boolean =>
  Object.entries(PROJECT_AFFINITY_STORE_CALL_LIMITS).every(
    ([name, maximum]) =>
      observation.calls[name as ProjectAffinityStoreCallName] <= maximum
  ) &&
  Object.keys(observation.unexpectedCalls).length === 0 &&
  observation.requestedCount <= 3 * observation.outputLimit &&
  observation.candidateCount <= observation.requestedCount &&
  observation.candidateCount <= 3 * observation.outputLimit;

export const corpusVectorCandidates = (
  documents: Awaited<ReturnType<StorePort["listDocuments"]>>,
  collections: readonly string[],
  startDistance = 0.3
): VectorSearchResult[] => {
  if (!documents.ok) throw new Error(documents.error.message);
  return documents.value
    .filter(
      (document) =>
        document.active &&
        document.mirrorHash &&
        collections.includes(document.collection)
    )
    .sort((left, right) => left.uri.localeCompare(right.uri, "en"))
    .map((document, index) => ({
      mirrorHash: document.mirrorHash!,
      seq: 0,
      distance: startDistance + index * 0.02,
    }));
};
