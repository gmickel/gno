/**
 * Malformed-memory diagnostics projected through status and audit.
 *
 * A memory-managed collection may contain hand-edited files that no longer
 * satisfy the record contract. Ingestion drops their scope rows (so managed
 * recall never returns them) while ordinary retrieval still sees the file.
 * This module names those files and their diagnostic codes.
 *
 * @module src/core/memory-diagnostics
 */

import type { Collection } from "../config/types";
import type { StorePort } from "../store/types";
import type { MemoryDiagnostic } from "./memory-record";

import { validateMemoryRecord } from "./memory-record";

/** Bounded list of malformed files per collection in status output. */
export const MEMORY_STATUS_MAX_MALFORMED = 20;

export interface MalformedMemoryRecord {
  uri: string;
  relPath: string;
  codes: string[];
  diagnostics: MemoryDiagnostic[];
}

export interface MemoryCollectionStatus {
  collection: string;
  /** Active documents indexed in the collection. */
  documents: number;
  /** Documents that satisfy the record contract (recallable). */
  records: number;
  malformed: number;
  malformedRecords: MalformedMemoryRecord[];
  /** True when more malformed files exist than were listed. */
  truncated: boolean;
}

export interface MemoryStatus {
  managedCollections: number;
  records: number;
  malformed: number;
  collections: MemoryCollectionStatus[];
}

export const memoryManagedCollections = (
  collections: readonly Collection[]
): Collection[] =>
  collections.filter((collection) => collection.memoryManaged === true);

/** Validate one indexed file as a memory record (null when unreadable). */
export const diagnoseMemoryContent = (
  content: string
): MemoryDiagnostic[] | null => {
  const validation = validateMemoryRecord(content);
  return validation.ok ? [] : validation.diagnostics;
};

/**
 * Scan every active document of each memory-managed collection through the
 * validator. Read-only; bounded by the collection's own document count.
 */
export async function buildMemoryStatus(
  store: Pick<StorePort, "listDocuments" | "getContent">,
  collections: readonly Collection[],
  options: { maxListed?: number } = {}
): Promise<MemoryStatus> {
  const maxListed = options.maxListed ?? MEMORY_STATUS_MAX_MALFORMED;
  const statuses: MemoryCollectionStatus[] = [];
  for (const collection of memoryManagedCollections(collections)) {
    const listed = await store.listDocuments(collection.name);
    const documents = listed.ok
      ? listed.value.filter((document) => document.active)
      : [];
    let records = 0;
    const malformedRecords: MalformedMemoryRecord[] = [];
    let malformed = 0;
    for (const document of documents) {
      if (!document.mirrorHash) continue;
      const content = await store.getContent(document.mirrorHash);
      if (!content.ok || content.value === null) continue;
      const diagnostics = diagnoseMemoryContent(content.value);
      if (diagnostics === null) continue;
      if (diagnostics.length === 0) {
        records += 1;
        continue;
      }
      malformed += 1;
      if (malformedRecords.length < maxListed) {
        malformedRecords.push({
          uri: document.uri,
          relPath: document.relPath,
          codes: [...new Set(diagnostics.map((item) => item.code))],
          diagnostics,
        });
      }
    }
    malformedRecords.sort((left, right) =>
      left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0
    );
    statuses.push({
      collection: collection.name,
      documents: documents.length,
      records,
      malformed,
      malformedRecords,
      truncated: malformed > malformedRecords.length,
    });
  }
  return {
    managedCollections: statuses.length,
    records: statuses.reduce((sum, item) => sum + item.records, 0),
    malformed: statuses.reduce((sum, item) => sum + item.malformed, 0),
    collections: statuses,
  };
}

/** Terminal lines for the `gno status` memory section. */
export function formatMemoryStatusLines(status: MemoryStatus): string[] {
  if (status.managedCollections === 0) {
    return ["Memory: no memory-managed collections"];
  }
  const lines = [
    `Memory: ${status.records} records, ${status.malformed} malformed across ${status.managedCollections} managed collection${status.managedCollections === 1 ? "" : "s"}`,
  ];
  for (const collection of status.collections) {
    lines.push(
      `  ${collection.collection}: ${collection.records} records` +
        (collection.malformed > 0
          ? `, ${collection.malformed} malformed (excluded from recall)`
          : "")
    );
    for (const record of collection.malformedRecords) {
      lines.push(`    ${record.relPath}: ${record.codes.join(", ")}`);
    }
    if (collection.truncated) {
      lines.push(
        `    ... ${collection.malformed - collection.malformedRecords.length} more (run: gno audit --category provenance)`
      );
    }
  }
  return lines;
}
