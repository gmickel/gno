import type { SearchOptions, SearchResult } from "../../../src/pipeline/types";
import type { StorePort } from "../../../src/store/types";
import type {
  AgentTask,
  CorpusSnapshot,
  NormalizedToolEvidence,
  NormalizedToolResult,
} from "../types";

import { searchBm25 } from "../../../src/pipeline/search";
import {
  canonicalJson,
  exactLineSpan,
  normalizeNewlines,
  sha256Bytes,
} from "../canonical";
import { mustNativeStore } from "../native-fixture-store";

export interface LexicalSearchOutcome {
  result: NormalizedToolResult;
  backendInvocations: number;
}

const optionalStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;

export const searchOptionsFromArguments = (
  arguments_: Readonly<Record<string, unknown>>
): SearchOptions => ({
  limit: typeof arguments_.limit === "number" ? arguments_.limit : undefined,
  minScore:
    typeof arguments_.minScore === "number" ? arguments_.minScore : undefined,
  collection:
    typeof arguments_.collection === "string"
      ? arguments_.collection
      : undefined,
  lang: typeof arguments_.lang === "string" ? arguments_.lang : undefined,
  tagsAll: optionalStringArray(arguments_.tagsAll),
  tagsAny: optionalStringArray(arguments_.tagsAny),
  since: typeof arguments_.since === "string" ? arguments_.since : undefined,
  until: typeof arguments_.until === "string" ? arguments_.until : undefined,
  categories: optionalStringArray(arguments_.categories),
  author: typeof arguments_.author === "string" ? arguments_.author : undefined,
  intent: typeof arguments_.intent === "string" ? arguments_.intent : undefined,
  exclude: optionalStringArray(arguments_.exclude),
  lineNumbers: true,
});

export const taskScopedSearchOptions = (
  task: Readonly<AgentTask>,
  arguments_: Readonly<Record<string, unknown>>
): SearchOptions[] => {
  const requested =
    typeof arguments_.collection === "string" ? arguments_.collection : null;
  if (requested && !task.corpus.collections.includes(requested)) {
    throw new Error(
      `Collection is outside the active task corpus: ${requested}`
    );
  }
  const scopes = requested ? [requested] : task.corpus.collections;
  return scopes.map((collection) => ({
    ...searchOptionsFromArguments(arguments_),
    collection,
  }));
};

export const assertTaskScopedUris = (
  task: Readonly<AgentTask>,
  uris: readonly string[]
): void => {
  for (const uri of uris) {
    const match = /^gno:\/\/([^/]+)\/.+/.exec(uri);
    if (!match || !task.corpus.collections.includes(match[1] as string)) {
      throw new Error(`URI is outside the active task corpus: ${uri}`);
    }
  }
};

const evidenceForSearchResult = (
  snapshot: CorpusSnapshot,
  taskId: string,
  result: SearchResult
): NormalizedToolEvidence[] => {
  const range = result.snippetRange;
  if (!range) return [];
  const source = snapshot.files.find(
    (file) =>
      file.taskId === taskId &&
      `gno://${file.collection}/${file.relPath}` === result.uri
  );
  if (!source) return [];
  const text = exactLineSpan(source.content, range.startLine, range.endLine);
  const observedSourceHash = sha256Bytes(source.content);
  if (
    observedSourceHash !== source.sourceHash ||
    (result.source.sourceHash &&
      result.source.sourceHash !== observedSourceHash)
  ) {
    throw new Error(`Search source hash drift for ${result.uri}`);
  }
  return normalizeNewlines(text)
    .split("\n")
    .flatMap((line, index) =>
      line.trim()
        ? [
            {
              uri: result.uri,
              sourceHash: observedSourceHash,
              startLine: range.startLine + index,
              endLine: range.startLine + index,
              spanHash: sha256Bytes(line),
              sourceHashProvenance: "harness_observed" as const,
              spanHashProvenance: "harness_observed" as const,
              text: line,
              backendSourceHash: null,
              backendSpanHash: null,
              backendHashUnavailableReason:
                "production lexical results do not provide complete source/span hash pairs",
            },
          ]
        : []
    );
};

export const runLexicalSearch = async (context: {
  store: StorePort;
  snapshot: CorpusSnapshot;
  taskId: string;
  query: string;
  options: SearchOptions;
}): Promise<LexicalSearchOutcome> => {
  const search = mustNativeStore(
    await searchBm25(context.store, context.query, context.options),
    "run production lexical search"
  );
  const evidence = search.results.flatMap((result) =>
    evidenceForSearchResult(context.snapshot, context.taskId, result)
  );
  return {
    result: {
      status: "ok",
      resultRole: "candidates",
      content: canonicalJson({
        mode: search.meta.mode,
        query: context.query,
        results: search.results.map((result) => ({
          uri: result.uri,
          score: result.score,
          startLine: result.snippetRange?.startLine ?? null,
          endLine: result.snippetRange?.endLine ?? null,
        })),
      }),
      evidence,
      errorCode: null,
    },
    backendInvocations: 1,
  };
};

const readOne = async (
  store: StorePort,
  uri: string,
  fromLine?: number,
  lineCount?: number
): Promise<{
  evidence: NormalizedToolEvidence[];
  invocations: number;
}> => {
  const document = mustNativeStore(
    await store.getDocumentByUri(uri),
    `read document ${uri}`
  );
  if (!document?.mirrorHash) return { evidence: [], invocations: 1 };
  const content = mustNativeStore(
    await store.getContent(document.mirrorHash),
    `read document content ${uri}`
  );
  if (content === null) return { evidence: [], invocations: 2 };
  const normalized = normalizeNewlines(content);
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  const startLine = fromLine ?? 1;
  const endLine = Math.min(
    lines.length,
    lineCount ? startLine + lineCount - 1 : lines.length
  );
  if (startLine > lines.length) return { evidence: [], invocations: 2 };
  const observedSourceHash = sha256Bytes(normalized);
  if (document.sourceHash !== observedSourceHash) {
    throw new Error(`Stored source hash drift for ${uri}`);
  }
  return {
    evidence: lines.slice(startLine - 1, endLine).flatMap((text, index) =>
      text.trim()
        ? [
            {
              uri,
              sourceHash: observedSourceHash,
              startLine: startLine + index,
              endLine: startLine + index,
              spanHash: sha256Bytes(text),
              sourceHashProvenance: "harness_observed" as const,
              spanHashProvenance: "harness_observed" as const,
              text,
              backendSourceHash: null,
              backendSpanHash: null,
              backendHashUnavailableReason:
                "production document reads do not provide complete source/span hash pairs",
            },
          ]
        : []
    ),
    invocations: 2,
  };
};

const applyCombinedByteLimit = (
  evidence: readonly NormalizedToolEvidence[],
  maxBytes: number | undefined
): NormalizedToolEvidence[] => {
  if (!maxBytes) return [...evidence];
  const selected: NormalizedToolEvidence[] = [];
  let used = 0;
  for (const item of evidence) {
    const bytes = new TextEncoder().encode(item.text).byteLength;
    if (used + bytes > maxBytes) break;
    selected.push(item);
    used += bytes;
  }
  return selected;
};

export const runLexicalRead = async (context: {
  store: StorePort;
  uris: readonly string[];
  fromLine?: number;
  lineCount?: number;
  maxBytes?: number;
}): Promise<LexicalSearchOutcome> => {
  const reads = [];
  let backendInvocations = 0;
  for (const uri of context.uris) {
    const read = await readOne(
      context.store,
      uri,
      context.fromLine,
      context.lineCount
    );
    backendInvocations += read.invocations;
    reads.push(...read.evidence);
  }
  const evidence = applyCombinedByteLimit(reads, context.maxBytes);
  return {
    result: {
      status: "ok",
      resultRole: "source",
      content: evidence.map((item) => item.text).join("\n"),
      evidence,
      errorCode: null,
    },
    backendInvocations,
  };
};
