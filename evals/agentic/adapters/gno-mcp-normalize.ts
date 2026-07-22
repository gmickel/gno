import type { GnoMcpCallResult } from "../lifecycle/gno-mcp";
import type {
  AgentTask,
  CorpusSnapshot,
  NormalizedToolEvidence,
  NormalizedToolResult,
} from "../types";

import { AgenticProductError } from "../adapter";
import {
  canonicalJson,
  exactLineSpan,
  normalizeNewlines,
  sha256Bytes,
} from "../canonical";
import {
  assertSourceIdentity,
  evidenceLineCount,
  type GetOutput,
  invalidProductOutput,
  isInteger,
  isNonnegativeInteger,
  type LineRangeOutput,
  type MultiGetDocumentOutput,
  type MultiGetMetaOutput,
  objectRecord,
  productLineCount,
  type SearchMetaOutput,
  type SearchResultOutput,
  sourceFor,
  stableUri,
} from "./gno-mcp-validate";

interface NormalizedMcpOutcome {
  result: NormalizedToolResult;
  backendInvocations: number;
  diagnostics: string[];
}

const evidenceForRange = (input: {
  snapshot: CorpusSnapshot;
  task: Readonly<AgentTask>;
  uri: string;
  startLine: number;
  endLine: number;
  text: string;
}): NormalizedToolEvidence[] | null => {
  const source = sourceFor(input.snapshot, input.task, input.uri);
  if (!source || input.startLine < 1 || input.endLine < input.startLine)
    return null;
  let observed: string;
  try {
    observed = exactLineSpan(source.content, input.startLine, input.endLine);
  } catch {
    return null;
  }
  const matchesExactSpan =
    observed === input.text || `${observed}\n` === input.text;
  if (!matchesExactSpan) return null;
  return observed.split("\n").map((text, index) => ({
    uri: stableUri(input.uri),
    sourceHash: source.sourceHash,
    startLine: input.startLine + index,
    endLine: input.startLine + index,
    spanHash: sha256Bytes(text),
    sourceHashProvenance: "harness_observed" as const,
    spanHashProvenance: "harness_observed" as const,
    text,
    backendSourceHash: null,
    backendSpanHash: null,
    backendHashUnavailableReason:
      "GNO MCP does not return a complete source/span hash pair",
  }));
};

const errorOutcome = (response: GnoMcpCallResult): NormalizedMcpOutcome => {
  const structured = objectRecord(response.structuredContent);
  const rawCode =
    typeof structured?.error === "string" ? structured.error : "RUNTIME";
  const errorCode = `gno_${rawCode.toLowerCase()}`;
  return {
    result: {
      status: "error",
      resultRole: "source",
      content: canonicalJson({ errorCode }),
      evidence: [],
      errorCode,
    },
    backendInvocations: 1,
    diagnostics: [
      "GNO MCP returned a product error; volatile message excluded",
    ],
  };
};

const normalizeSearch = (
  response: GnoMcpCallResult,
  snapshot: CorpusSnapshot,
  task: Readonly<AgentTask>
): NormalizedMcpOutcome => {
  const structured = objectRecord(response.structuredContent);
  if (!structured || !Array.isArray(structured.results)) {
    invalidProductOutput("query results must be an array");
  }
  const validStructured = structured as Record<string, unknown>;
  const rawResults = validStructured.results as unknown[];
  const meta = objectRecord(validStructured.meta);
  if (
    !meta ||
    typeof meta.query !== "string" ||
    !["bm25", "vector", "hybrid", "bm25_only"].includes(
      typeof meta.mode === "string" ? meta.mode : ""
    ) ||
    typeof meta.expanded !== "boolean" ||
    typeof meta.reranked !== "boolean" ||
    typeof meta.vectorsUsed !== "boolean" ||
    !isNonnegativeInteger(meta.totalResults)
  ) {
    invalidProductOutput("query metadata is invalid");
  }
  const validMeta = meta as SearchMetaOutput;
  const query = validMeta.query.trim().toLowerCase();
  const diagnostics: string[] = [];
  const evidence: NormalizedToolEvidence[] = [];
  const results = rawResults.map((raw) => {
    const result = objectRecord(raw);
    if (
      !result ||
      typeof result.uri !== "string" ||
      typeof result.docid !== "string" ||
      typeof result.snippet !== "string" ||
      typeof result.score !== "number" ||
      !Number.isFinite(result.score) ||
      result.score < 0 ||
      result.score > 1
    ) {
      invalidProductOutput("query result fields are invalid");
    }
    const validResult = result as SearchResultOutput;
    const uri = stableUri(validResult.uri);
    const source = objectRecord(validResult.source);
    const range = objectRecord(validResult.snippetRange);
    if (
      !range ||
      !isInteger(range.startLine) ||
      !isInteger(range.endLine) ||
      range.startLine < 1 ||
      range.endLine < range.startLine
    ) {
      invalidProductOutput("query snippet range is invalid");
    }
    const validRange = range as LineRangeOutput;
    const fixtureSource = assertSourceIdentity(
      snapshot,
      task,
      uri,
      source,
      "search"
    );
    const startLine = validRange.startLine;
    const endLine = validRange.endLine;
    if (endLine > productLineCount(fixtureSource.content)) {
      invalidProductOutput("query snippet range exceeds the source");
    }
    const snippet = validResult.snippet;
    const coordinate = evidenceForRange({
      snapshot,
      task,
      uri,
      startLine,
      endLine,
      text: snippet,
    });
    if (coordinate) {
      const phraseMatches = query
        ? coordinate.filter((item) => item.text.toLowerCase().includes(query))
        : [];
      evidence.push(...(phraseMatches.length > 0 ? phraseMatches : coordinate));
    } else diagnostics.push(`Ignored non-exact candidate span for ${uri}`);
    return {
      uri,
      docid: validResult.docid,
      title: typeof validResult.title === "string" ? validResult.title : null,
      score: validResult.score,
      snippet,
      snippetRange: { startLine, endLine },
      context:
        typeof validResult.context === "string" ? validResult.context : null,
      sourceHash: source?.sourceHash,
    };
  });
  const stableMeta = {
    query: validMeta.query,
    mode: validMeta.mode,
    expanded: validMeta.expanded,
    reranked: validMeta.reranked,
    vectorsUsed: validMeta.vectorsUsed,
    totalResults: validMeta.totalResults,
  };
  const graph = objectRecord(meta?.graphExpansion);
  const backendInvocations =
    1 +
    (stableMeta.vectorsUsed ? 1 : 0) +
    (stableMeta.expanded ? 1 : 0) +
    (stableMeta.reranked ? 1 : 0) +
    (graph?.enabled === true ? 1 : 0);
  return {
    result: {
      status: "ok",
      resultRole: "candidates",
      content: canonicalJson({ results, meta: stableMeta }),
      evidence,
      errorCode: null,
    },
    backendInvocations,
    diagnostics,
  };
};

const normalizeGet = (
  response: GnoMcpCallResult,
  snapshot: CorpusSnapshot,
  task: Readonly<AgentTask>
): NormalizedMcpOutcome => {
  const value = objectRecord(response.structuredContent);
  if (
    !value ||
    typeof value.uri !== "string" ||
    typeof value.docid !== "string" ||
    typeof value.content !== "string" ||
    !isNonnegativeInteger(value.totalLines)
  ) {
    invalidProductOutput("get fields are invalid");
  }
  const validValue = value as GetOutput;
  const uri = stableUri(validValue.uri);
  const content = validValue.content;
  const totalLines = validValue.totalLines;
  const returned = objectRecord(validValue.returnedLines);
  if (
    validValue.returnedLines !== undefined &&
    (!returned ||
      !isInteger(returned.start) ||
      !isInteger(returned.end) ||
      returned.start < 1 ||
      returned.end < returned.start)
  ) {
    invalidProductOutput("get returned line range is invalid");
  }
  const startLine = isInteger(returned?.start) ? returned.start : 1;
  const fixtureSource = sourceFor(snapshot, task, uri);
  if (!fixtureSource) {
    throw new AgenticProductError(
      "gno_corpus_isolation_violation",
      "GNO MCP get returned a source outside the visible task corpus"
    );
  }
  assertSourceIdentity(
    snapshot,
    task,
    uri,
    objectRecord(validValue.source),
    "get"
  );
  const fixtureContent = normalizeNewlines(fixtureSource.content);
  const fixtureLineCount = productLineCount(fixtureContent);
  if (totalLines !== fixtureLineCount) {
    invalidProductOutput("get totalLines differs from the source");
  }
  const returnedEnd = isInteger(returned?.end) ? returned.end : null;
  if (returnedEnd !== null && returnedEnd > fixtureLineCount) {
    invalidProductOutput("get returned line range exceeds the source");
  }
  const coordinate =
    returnedEnd !== null
      ? evidenceForRange({
          snapshot,
          task,
          uri,
          startLine,
          endLine: returnedEnd,
          text: content,
        })
      : content === fixtureContent
        ? evidenceForRange({
            snapshot,
            task,
            uri,
            startLine: 1,
            endLine: evidenceLineCount(fixtureContent),
            text: content,
          })
        : null;
  return {
    result: {
      status: "ok",
      resultRole: "source",
      content: canonicalJson({
        uri,
        totalLines,
        returnedLines:
          returnedEnd === null ? null : { start: startLine, end: returnedEnd },
        content,
      }),
      evidence: coordinate ?? [],
      errorCode: null,
    },
    backendInvocations: 1,
    diagnostics: coordinate
      ? []
      : [`GNO MCP get did not expose an exact fixture span for ${uri}`],
  };
};

const normalizeMultiGet = (
  response: GnoMcpCallResult,
  snapshot: CorpusSnapshot,
  task: Readonly<AgentTask>
): NormalizedMcpOutcome => {
  const value = objectRecord(response.structuredContent);
  const meta = objectRecord(value?.meta);
  if (
    !value ||
    !Array.isArray(value.documents) ||
    !Array.isArray(value.skipped) ||
    !meta ||
    !isNonnegativeInteger(meta.requested) ||
    !isNonnegativeInteger(meta.returned) ||
    !isNonnegativeInteger(meta.skipped)
  ) {
    invalidProductOutput("multi_get envelope is invalid");
  }
  const validEnvelope = value as Record<string, unknown>;
  const validMeta = meta as MultiGetMetaOutput;
  const rawDocuments = validEnvelope.documents as unknown[];
  const rawSkippedEntries = validEnvelope.skipped as unknown[];
  if (
    validMeta.returned !== rawDocuments.length ||
    validMeta.skipped !== rawSkippedEntries.length ||
    validMeta.requested !== validMeta.returned + validMeta.skipped
  ) {
    invalidProductOutput("multi_get counts are inconsistent");
  }
  for (const rawSkipped of rawSkippedEntries) {
    const skipped = objectRecord(rawSkipped);
    if (
      !skipped ||
      typeof skipped.ref !== "string" ||
      typeof skipped.reason !== "string"
    ) {
      invalidProductOutput("multi_get skipped entry is invalid");
    }
  }
  const evidence: NormalizedToolEvidence[] = [];
  const diagnostics: string[] = [];
  const documents = rawDocuments.map((raw) => {
    const document = objectRecord(raw);
    if (
      !document ||
      typeof document.uri !== "string" ||
      typeof document.docid !== "string" ||
      typeof document.content !== "string" ||
      !isNonnegativeInteger(document.totalLines) ||
      typeof document.truncated !== "boolean"
    ) {
      invalidProductOutput("multi_get document fields are invalid");
    }
    const validDocument = document as MultiGetDocumentOutput;
    const uri = stableUri(validDocument.uri);
    const fixtureSource = sourceFor(snapshot, task, uri);
    if (!fixtureSource) {
      throw new AgenticProductError(
        "gno_corpus_isolation_violation",
        "GNO MCP multi_get returned a source outside the visible task corpus"
      );
    }
    const productSource = objectRecord(validDocument.source);
    if (
      !productSource ||
      typeof productSource.relPath !== "string" ||
      typeof productSource.mime !== "string" ||
      typeof productSource.ext !== "string" ||
      productSource.relPath !== fixtureSource.relPath
    ) {
      invalidProductOutput("multi_get source identity is invalid");
    }
    const content = validDocument.content;
    const totalLines = validDocument.totalLines;
    if (totalLines !== productLineCount(fixtureSource.content)) {
      invalidProductOutput("multi_get totalLines differs from the source");
    }
    const normalizedSource = normalizeNewlines(fixtureSource.content);
    const exactContent = content === normalizedSource;
    if (exactContent) {
      const sourceLineCount = normalizedSource.endsWith("\n")
        ? normalizedSource.slice(0, -1).split("\n").length
        : normalizedSource.split("\n").length;
      const coordinate = evidenceForRange({
        snapshot,
        task,
        uri,
        startLine: 1,
        endLine: sourceLineCount,
        text: content,
      });
      if (coordinate) evidence.push(...coordinate);
    } else {
      diagnostics.push(
        `GNO MCP multi_get returned truncated or non-exact content for ${uri}`
      );
    }
    return { uri, totalLines, truncated: validDocument.truncated, content };
  });
  return {
    result: {
      status: "ok",
      resultRole: "source",
      content: canonicalJson({ documents }),
      evidence,
      errorCode: null,
    },
    backendInvocations: 1,
    diagnostics,
  };
};

export const normalizeGnoMcpResult = (
  toolName: string,
  response: GnoMcpCallResult,
  snapshot: CorpusSnapshot,
  task: Readonly<AgentTask>
): NormalizedMcpOutcome => {
  if (response.isError === true) return errorOutcome(response);
  if (toolName === "search") return normalizeSearch(response, snapshot, task);
  if (toolName === "get") return normalizeGet(response, snapshot, task);
  return normalizeMultiGet(response, snapshot, task);
};
