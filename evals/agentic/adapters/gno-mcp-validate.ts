import type { AgentTask, CorpusSnapshot } from "../types";

import { AgenticProductError } from "../adapter";
import { normalizeNewlines } from "../canonical";

export interface SearchMetaOutput extends Record<string, unknown> {
  query: string;
  mode: string;
  expanded: boolean;
  reranked: boolean;
  vectorsUsed: boolean;
  totalResults: number;
}

export interface SearchResultOutput extends Record<string, unknown> {
  uri: string;
  docid: string;
  snippet: string;
  score: number;
}

export interface LineRangeOutput extends Record<string, unknown> {
  startLine: number;
  endLine: number;
}

export interface GetOutput extends Record<string, unknown> {
  uri: string;
  docid: string;
  content: string;
  totalLines: number;
}

export interface MultiGetDocumentOutput extends Record<string, unknown> {
  uri: string;
  docid: string;
  content: string;
  totalLines: number;
  truncated: boolean;
}

export interface MultiGetMetaOutput extends Record<string, unknown> {
  requested: number;
  returned: number;
  skipped: number;
}

export const objectRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const invalidProductOutput = (detail: string): never => {
  throw new AgenticProductError(
    "gno_mcp_output_invalid",
    `GNO MCP returned malformed structured output: ${detail}`
  );
};

export const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

export const isNonnegativeInteger = (value: unknown): value is number =>
  isInteger(value) && value >= 0;

export const evidenceLineCount = (content: string): number => {
  const normalized = normalizeNewlines(content);
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n").length
    : normalized.split("\n").length;
};

export const productLineCount = (content: string): number =>
  normalizeNewlines(content).split("\n").length;

export const stableUri = (uri: string): string =>
  uri.replace(/\?index=agentic$/, "");

export const sourceFor = (
  snapshot: CorpusSnapshot,
  task: Readonly<AgentTask>,
  uri: string
) =>
  snapshot.files.find(
    (file) =>
      file.taskId === task.taskId &&
      `gno://${file.collection}/${file.relPath}` === stableUri(uri)
  );

export const assertSourceIdentity = (
  snapshot: CorpusSnapshot,
  task: Readonly<AgentTask>,
  uri: string,
  source: Record<string, unknown> | null,
  output: string
): CorpusSnapshot["files"][number] => {
  const fixture = sourceFor(snapshot, task, uri);
  if (!fixture) {
    throw new AgenticProductError(
      "gno_corpus_isolation_violation",
      `GNO MCP ${output} returned a source outside the visible task corpus`
    );
  }
  if (
    !source ||
    typeof source.relPath !== "string" ||
    typeof source.mime !== "string" ||
    typeof source.ext !== "string" ||
    typeof source.sourceHash !== "string" ||
    source.relPath !== fixture.relPath ||
    source.sourceHash !== fixture.sourceHash
  ) {
    invalidProductOutput(`${output} source identity is invalid`);
  }
  return fixture;
};
