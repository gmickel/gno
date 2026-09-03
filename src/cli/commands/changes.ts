/** CLI adapters and readable formatters for knowledge delta read services. */

import type {
  KnowledgeChangesResult,
  KnowledgeDeltaServiceResult,
  KnowledgeDiffResult,
  KnowledgeImpactInput,
  KnowledgeImpactResult,
  ListKnowledgeChangesInput,
} from "../../core/knowledge-delta";
import type { StorePort } from "../../store/types";
import type { ChangesFollowLine, FollowChangesResult } from "./changes-follow";

import {
  analyzeKnowledgeImpact,
  getKnowledgeDiff,
  listKnowledgeChanges,
} from "../../core/knowledge-delta";
import { followChanges, validateFollowCursor } from "./changes-follow";
import { initStore } from "./shared";

export interface KnowledgeDeltaCliContext {
  configPath?: string;
  indexName?: string;
}

export const changesRead = (
  store: StorePort,
  input: ListKnowledgeChangesInput = {}
): Promise<KnowledgeDeltaServiceResult<KnowledgeChangesResult>> =>
  listKnowledgeChanges(store, input);

export const diffRead = (
  store: StorePort,
  ref: string,
  changeId?: string
): Promise<KnowledgeDeltaServiceResult<KnowledgeDiffResult>> =>
  getKnowledgeDiff(store, ref, changeId);

export const impactRead = (
  store: StorePort,
  ref: string,
  input: KnowledgeImpactInput = {}
): Promise<KnowledgeDeltaServiceResult<KnowledgeImpactResult>> =>
  analyzeKnowledgeImpact(store, ref, input);

const withStore = async <T>(
  context: KnowledgeDeltaCliContext,
  operation: (store: StorePort) => Promise<KnowledgeDeltaServiceResult<T>>
): Promise<KnowledgeDeltaServiceResult<T>> => {
  const initialized = await initStore({
    configPath: context.configPath,
    indexName: context.indexName,
    syncConfig: false,
    allowEmptyCollections: true,
  });
  if (!initialized.ok) {
    return { success: false, error: initialized.error };
  }
  try {
    return await operation(initialized.store);
  } finally {
    await initialized.store.close();
  }
};

export const changes = (
  input: ListKnowledgeChangesInput,
  context: KnowledgeDeltaCliContext = {}
): Promise<KnowledgeDeltaServiceResult<KnowledgeChangesResult>> =>
  withStore(context, (store) => changesRead(store, input));

export const diff = (
  ref: string,
  changeId: string | undefined,
  context: KnowledgeDeltaCliContext = {}
): Promise<KnowledgeDeltaServiceResult<KnowledgeDiffResult>> =>
  withStore(context, (store) => diffRead(store, ref, changeId));

export const impact = (
  ref: string,
  input: KnowledgeImpactInput,
  context: KnowledgeDeltaCliContext = {}
): Promise<KnowledgeDeltaServiceResult<KnowledgeImpactResult>> =>
  withStore(context, (store) => impactRead(store, ref, input));

export interface ChangesFollowInput {
  cursor?: string;
  collection?: string;
}

/** Abort on SIGINT/SIGTERM so the stream ends cleanly after the current line. */
const abortOnSignals = (): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return {
    signal: controller.signal,
    dispose: (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
  };
};

/**
 * `gno changes --follow --jsonl`: stream journal events as JSON lines on
 * stdout until a signal arrives or the resume cursor expires.
 */
export const changesFollow = async (
  input: ChangesFollowInput,
  context: KnowledgeDeltaCliContext = {},
  emit: (line: ChangesFollowLine) => void = (line) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
): Promise<FollowChangesResult> => {
  if (input.cursor !== undefined) {
    const invalid = validateFollowCursor(input.cursor);
    if (invalid) return { status: "error", error: invalid, isValidation: true };
  }
  const collection = input.collection?.trim();
  if (input.collection !== undefined && !collection) {
    return {
      status: "error",
      error: "collection cannot be empty",
      isValidation: true,
    };
  }
  const signals = abortOnSignals();
  try {
    const result = await withStore(context, async (store) => ({
      success: true as const,
      data: await followChanges(
        store,
        { cursor: input.cursor, collection, signal: signals.signal },
        emit
      ),
    }));
    return result.success
      ? result.data
      : { status: "error", error: result.error, isValidation: false };
  } finally {
    signals.dispose();
  }
};

const json = (value: unknown): string => JSON.stringify(value, null, 2);

export function formatChanges(
  result: KnowledgeChangesResult,
  format: "terminal" | "json"
): string {
  if (format === "json") return json(result);
  const lines = [`${result.changes.length} retained changes`];
  for (const change of result.changes) {
    const uri = change.current?.uri ?? change.previous?.uri ?? "(unknown)";
    lines.push(
      `${change.observedAt}  ${change.kind.padEnd(10)}  ${uri}  ${change.id}`
    );
  }
  if (result.page.cursorExpired) {
    lines.push(`Cursor expired; earliest: ${result.page.earliestCursor}`);
  } else if (result.page.nextCursor) {
    lines.push(`Next cursor: ${result.page.nextCursor}`);
  }
  for (const warning of result.warnings) {
    lines.push(`Warning: ${warning}`);
  }
  return lines.join("\n");
}

export function formatDiff(
  result: KnowledgeDiffResult,
  format: "terminal" | "json"
): string {
  if (format === "json") return json(result);
  const lines = [
    `Structural diff for ${result.document.uri}`,
    `Status: ${result.status}`,
    `History: ${result.history.status}${result.history.reason ? ` (${result.history.reason})` : ""}`,
    "Content: not retained (metadata-only journal)",
  ];
  if (result.change) {
    const delta = result.change.structureDelta;
    lines.push(
      `Change: ${result.change.kind} at ${result.change.observedAt} (${result.change.id})`,
      `Headings: +${delta.headings.added.length} -${delta.headings.removed.length}`,
      `Links: +${delta.links.added.length} -${delta.links.removed.length}`,
      `Typed edges: +${delta.typedEdges.added.length} -${delta.typedEdges.removed.length}`,
      `Dates: +${delta.dates.added.length} -${delta.dates.removed.length} ~${delta.dates.changed.length}`
    );
  }
  for (const warning of result.warnings) {
    lines.push(`Warning: ${warning}`);
  }
  return lines.join("\n");
}

export function formatImpact(
  result: KnowledgeImpactResult,
  format: "terminal" | "json"
): string {
  if (format === "json") return json(result);
  const lines = [
    `${result.impacted.length} documents depend on ${result.root.uri}`,
  ];
  for (const item of result.impacted) {
    const path = item.evidencePath
      .map(
        (step) => `${step.source.uri} -[${step.edgeType}]-> ${step.target.uri}`
      )
      .join(" -> ");
    lines.push(`depth ${item.depth}  ${item.document.uri}`, `  ${path}`);
  }
  if (result.meta.truncated) {
    lines.push("Traversal truncated by configured caps");
  }
  for (const warning of result.meta.warnings) {
    lines.push(`Warning: ${warning}`);
  }
  return lines.join("\n");
}
