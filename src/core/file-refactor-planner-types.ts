/**
 * Shared planner document / input types for reference-safe refactors.
 *
 * @module src/core/file-refactor-planner-types
 */

import type { FileRefactorOperation } from "./file-refactor-contract";

export const FILE_REFACTOR_PLANNER_CAPS = {
  maxCatalogDocuments: 5_000,
  maxContentDocuments: 5_000,
  maxExaminedReferences: 10_000,
  maxContentCharsPerDocument: 1_000_000,
  /** Aggregate UTF-16 content budget across inventoried documents. */
  maxTotalContentChars: 20_000_000,
} as const;

export interface FileRefactorPlannerDocument {
  id: number;
  uri: string;
  relPath: string;
  collection: string;
  title: string | null;
  /** Full UTF-8 markdown body when this document should be inventoried. */
  content?: string | null;
  /** True when a potentially relevant doc lacked mirror content. */
  contentMissing?: boolean;
  /** False for read-only / logical-record referrers. Defaults to true. */
  editable?: boolean;
  /** Optional capability denial reason for diagnostics. */
  editableReason?: string;
  active?: boolean;
}

export interface PlanFileRefactorImpactInput {
  operation: FileRefactorOperation;
  source: {
    uri: string;
    relPath: string;
    collection: string;
    title?: string | null;
    content: string;
    editable: boolean;
  };
  target: {
    uri: string;
    relPath: string;
    collection: string;
    title?: string | null;
  };
  /** Active documents used for resolution + optional content inventory. */
  documents: FileRefactorPlannerDocument[];
  /** Occupancy check: true when target path already exists as another doc. */
  targetOccupied: boolean;
  /** Optional content-free occupancy fingerprint seed (defaults to target path). */
  targetPathFingerprintSeed?: string;
  /**
   * Explicit truncation / completeness reasons from the store read seam.
   * Callers must not drop these — they force canApply=false.
   */
  truncationReasons?: readonly string[];
}
