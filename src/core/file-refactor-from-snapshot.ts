/**
 * Safe adapter from store resolution snapshot → planner input.
 * Preserves truncation reasons so callers cannot drop them.
 *
 * @module src/core/file-refactor-from-snapshot
 */

import type { FileRefactorOperation } from "./file-refactor-contract";
import type {
  FileRefactorPlannerDocument,
  PlanFileRefactorImpactInput,
} from "./file-refactor-planner-types";

import { planFileRefactorImpact } from "./file-refactor-planner";

/** Store-seam snapshot shape (structurally matches FileRefactorResolutionSnapshot). */
export interface FileRefactorSnapshotLike {
  source: {
    id: number;
    uri: string;
    relPath: string;
    collection: string;
    title: string | null;
    content: string | null;
    contentTruncated: boolean;
    editable: boolean;
    editableReason?: string;
  };
  catalog: Array<{
    id: number;
    uri: string;
    relPath: string;
    collection: string;
    title: string | null;
  }>;
  referrers: Array<{
    id: number;
    uri: string;
    relPath: string;
    collection: string;
    title: string | null;
    content: string | null;
    contentTruncated: boolean;
    contentMissing: boolean;
    editable: boolean;
    editableReason?: string;
  }>;
  truncated: boolean;
  truncationReasons: string[];
}

export function planInputFromResolutionSnapshot(input: {
  operation: FileRefactorOperation;
  snapshot: FileRefactorSnapshotLike;
  target: {
    uri: string;
    relPath: string;
    collection: string;
    title?: string | null;
  };
  targetOccupied: boolean;
  sourceEditable?: boolean;
}): PlanFileRefactorImpactInput {
  const { snapshot } = input;
  const truncationReasons = [...snapshot.truncationReasons];
  if (snapshot.truncated && truncationReasons.length === 0) {
    truncationReasons.push("snapshot_truncated");
  }
  // Defensive: legacy/custom snapshots may omit the reason while content is null.
  if (snapshot.source.content === null) {
    truncationReasons.push("source_content_missing");
  }
  if (snapshot.source.contentTruncated) {
    truncationReasons.push("source_content_truncated");
  }

  const documents: FileRefactorPlannerDocument[] = snapshot.catalog.map(
    (doc) => ({
      id: doc.id,
      uri: doc.uri,
      relPath: doc.relPath,
      collection: doc.collection,
      title: doc.title,
      active: true,
    })
  );

  const byUri = new Map(documents.map((doc) => [doc.uri, doc]));
  for (const referrer of snapshot.referrers) {
    let doc = byUri.get(referrer.uri);
    if (!doc) {
      doc = {
        id: referrer.id,
        uri: referrer.uri,
        relPath: referrer.relPath,
        collection: referrer.collection,
        title: referrer.title,
        active: true,
      };
      documents.push(doc);
      byUri.set(doc.uri, doc);
    }
    doc.editable = referrer.editable;
    doc.editableReason = referrer.editableReason;
    if (referrer.contentMissing) {
      doc.contentMissing = true;
      doc.content = null;
      truncationReasons.push("referrer_content_missing");
    } else {
      doc.content = referrer.content ?? null;
      if (referrer.contentTruncated) {
        truncationReasons.push("referrer_content_truncated");
      }
    }
  }

  return {
    operation: input.operation,
    source: {
      uri: snapshot.source.uri,
      relPath: snapshot.source.relPath,
      collection: snapshot.source.collection,
      title: snapshot.source.title,
      content: snapshot.source.content ?? "",
      editable: input.sourceEditable ?? snapshot.source.editable,
    },
    target: input.target,
    documents,
    targetOccupied: input.targetOccupied,
    truncationReasons: [...new Set(truncationReasons)].sort(),
  };
}

/** Plan impact directly from a store snapshot without dropping truncation. */
export async function planFileRefactorImpactFromSnapshot(input: {
  operation: FileRefactorOperation;
  snapshot: FileRefactorSnapshotLike;
  target: {
    uri: string;
    relPath: string;
    collection: string;
    title?: string | null;
  };
  targetOccupied: boolean;
  sourceEditable?: boolean;
}) {
  return planFileRefactorImpact(planInputFromResolutionSnapshot(input));
}
