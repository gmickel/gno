/**
 * Pure parser-backed reference impact planner for rename / same-collection move.
 *
 * Accepts a bounded document snapshot; never reads or writes user files.
 *
 * @module src/core/file-refactor-planner
 */

import type {
  FileRefactorAffectedDocument,
  FileRefactorDestinationSpan,
  FileRefactorExaminedReference,
  FileRefactorPreviewPlan,
} from "./file-refactor-contract";
import type {
  FileRefactorPlannerDocument,
  PlanFileRefactorImpactInput,
} from "./file-refactor-planner-types";
import type { FileRefactorCatalogDocument } from "./file-refactor-resolve";

import {
  FILE_REFACTOR_MUTATION_BOUNDARY,
  FILE_REFACTOR_SCHEMA_VERSION,
  computeFileRefactorPlanDigest,
  deriveCanApply,
  fingerprintUtf8Content,
  sortExaminedReferences,
  summarizeReferenceClassifications,
} from "./file-refactor-contract";
import { classifyResolvableToken } from "./file-refactor-plan-classify";
import {
  pathBasename,
  pathDirname,
  validateFileRefactorPlanInputs,
} from "./file-refactor-plan-validate";
import { FILE_REFACTOR_PLANNER_CAPS } from "./file-refactor-planner-types";
import {
  buildSourceRelevanceKeys,
  inventoryDocumentLinks,
} from "./link-inventory";

export {
  FILE_REFACTOR_PLANNER_CAPS,
  type FileRefactorPlannerDocument,
  type PlanFileRefactorImpactInput,
} from "./file-refactor-planner-types";

function toCatalog(
  documents: FileRefactorPlannerDocument[]
): FileRefactorCatalogDocument[] {
  return documents.map((doc) => ({
    id: doc.id,
    uri: doc.uri,
    relPath: doc.relPath,
    collection: doc.collection,
    title: doc.title,
    active: doc.active,
  }));
}

async function emptyBlockedPlan(
  input: PlanFileRefactorImpactInput,
  examined: FileRefactorExaminedReference[],
  warnings: string[]
): Promise<FileRefactorPreviewPlan> {
  const orderedExamined = sortExaminedReferences(examined);
  const safety = summarizeReferenceClassifications(orderedExamined, {
    warnings,
    backlinks: orderedExamined.length,
  });
  const sourceContentFingerprint = await fingerprintUtf8Content(
    input.source.content
  );
  const targetPathFingerprint = await fingerprintUtf8Content(
    input.targetPathFingerprintSeed ??
      `${input.target.collection}:${input.target.relPath}:${input.targetOccupied ? "occupied" : "free"}`
  );
  const withoutDigest: Omit<FileRefactorPreviewPlan, "planDigest"> = {
    schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
    operation: input.operation,
    conflictPolicy: "fail",
    source: {
      uri: input.source.uri,
      relPath: input.source.relPath,
      collection: input.source.collection,
    },
    target: {
      uri: input.target.uri,
      relPath: input.target.relPath,
      collection: input.target.collection,
    },
    affectedDocuments: [],
    examinedReferences: orderedExamined,
    preconditions: {
      sourceContentFingerprint,
      affectedContentFingerprints: [],
      targetPathFingerprint,
    },
    safety,
    canApply: false,
    mutationBoundary: FILE_REFACTOR_MUTATION_BOUNDARY,
  };
  const planDigest = await computeFileRefactorPlanDigest(withoutDigest);
  return { ...withoutDigest, planDigest };
}

/**
 * Build a deterministic FileRefactorPreviewPlan from an in-memory snapshot.
 */
export async function planFileRefactorImpact(
  input: PlanFileRefactorImpactInput
): Promise<FileRefactorPreviewPlan> {
  const validation = validateFileRefactorPlanInputs(input);
  if (validation) {
    return emptyBlockedPlan(input, validation.examined, [
      `plan_invalid:${validation.diagnostic}`,
    ]);
  }

  const truncatedReasons = [...new Set(input.truncationReasons ?? [])].sort();
  const catalogDocs = input.documents;

  if (catalogDocs.length > FILE_REFACTOR_PLANNER_CAPS.maxCatalogDocuments) {
    truncatedReasons.push("catalog_truncated");
  }
  // Inventory + resolution must operate on the bounded catalog slice only.
  const boundedCatalogDocs = catalogDocs.slice(
    0,
    FILE_REFACTOR_PLANNER_CAPS.maxCatalogDocuments
  );
  const catalog = toCatalog(boundedCatalogDocs);

  const sourceKeys = buildSourceRelevanceKeys({
    relPath: input.source.relPath,
    title: input.source.title,
  });

  // Inventory source content for self-references, plus every content-bearing
  // same-collection document (including docs whose only hit is opaque syntax).
  const contentDocs: FileRefactorPlannerDocument[] = [];
  const seenContentUris = new Set<string>();

  const pushContentDoc = (doc: FileRefactorPlannerDocument): boolean => {
    if (seenContentUris.has(doc.uri)) return true;
    if (doc.collection !== input.source.collection) return true;
    if (contentDocs.length >= FILE_REFACTOR_PLANNER_CAPS.maxContentDocuments) {
      truncatedReasons.push("content_documents_truncated");
      return false;
    }
    seenContentUris.add(doc.uri);
    contentDocs.push(doc);
    return true;
  };

  pushContentDoc({
    id: -1,
    uri: input.source.uri,
    relPath: input.source.relPath,
    collection: input.source.collection,
    title: input.source.title ?? null,
    content: input.source.content,
    editable: input.source.editable,
  });

  for (const doc of boundedCatalogDocs) {
    if (doc.contentMissing) {
      truncatedReasons.push("referrer_content_missing");
      if (!pushContentDoc(doc)) break;
      continue;
    }
    if (doc.content === undefined || doc.content === null) continue;
    if (!pushContentDoc(doc)) break;
  }

  let totalContentChars = 0;
  const examined: FileRefactorExaminedReference[] = [];
  const byDocument = new Map<
    string,
    {
      doc: FileRefactorPlannerDocument;
      examined: FileRefactorExaminedReference[];
      edits: FileRefactorDestinationSpan[];
    }
  >();

  const considerDoc = (
    doc: FileRefactorPlannerDocument,
    content: string
  ): void => {
    if (doc.contentMissing) {
      if (examined.length >= FILE_REFACTOR_PLANNER_CAPS.maxExaminedReferences) {
        truncatedReasons.push("examined_truncated");
        return;
      }
      examined.push({
        documentUri: doc.uri,
        documentRelPath: doc.relPath,
        kind: "opaque",
        classification: "invalid",
        reasonCode: "unsafe_target",
        originalDestination: "referrer_content_missing",
      });
      return;
    }
    if (
      content.length > FILE_REFACTOR_PLANNER_CAPS.maxContentCharsPerDocument
    ) {
      truncatedReasons.push("content_size_truncated");
      examined.push({
        documentUri: doc.uri,
        documentRelPath: doc.relPath,
        kind: "opaque",
        classification: "invalid",
        reasonCode: "unsafe_target",
      });
      return;
    }
    totalContentChars += content.length;
    if (totalContentChars > FILE_REFACTOR_PLANNER_CAPS.maxTotalContentChars) {
      truncatedReasons.push("total_content_truncated");
      examined.push({
        documentUri: doc.uri,
        documentRelPath: doc.relPath,
        kind: "opaque",
        classification: "invalid",
        reasonCode: "unsafe_target",
        originalDestination: "total_content_truncated",
      });
      return;
    }

    const inventory = inventoryDocumentLinks(content, { sourceKeys });
    if (inventory.truncated) {
      truncatedReasons.push("inventory_truncated");
      examined.push({
        documentUri: doc.uri,
        documentRelPath: doc.relPath,
        kind: "opaque",
        classification: "invalid",
        reasonCode: "unsafe_target",
      });
    }
    if (inventory.overlapping) {
      truncatedReasons.push("overlapping_destination_spans");
      examined.push({
        documentUri: doc.uri,
        documentRelPath: doc.relPath,
        kind: "opaque",
        classification: "invalid",
        reasonCode: "unsafe_target",
        originalDestination: "overlapping_destination_spans",
      });
    }

    for (const token of inventory.tokens) {
      const row = classifyResolvableToken({
        token,
        doc,
        sourceUri: input.source.uri,
        sourceRelPath: input.source.relPath,
        sourceTitle: input.source.title,
        targetRelPath: input.target.relPath,
        targetTitle: input.target.title,
        catalog,
      });
      if (!row) continue;
      if (examined.length >= FILE_REFACTOR_PLANNER_CAPS.maxExaminedReferences) {
        truncatedReasons.push("examined_truncated");
        break;
      }
      examined.push(row);
      let bucket = byDocument.get(doc.uri);
      if (!bucket) {
        bucket = { doc, examined: [], edits: [] };
        byDocument.set(doc.uri, bucket);
      }
      bucket.examined.push(row);
      if (row.edit) bucket.edits.push(row.edit);
    }
  };

  for (const doc of contentDocs) {
    if (truncatedReasons.includes("examined_truncated")) break;
    if (truncatedReasons.includes("total_content_truncated")) break;
    considerDoc(doc, doc.content ?? "");
  }

  const uniqueTruncation = [...new Set(truncatedReasons)].sort();
  const orderedExamined = sortExaminedReferences(examined);
  const affectedDocuments: FileRefactorAffectedDocument[] = [];
  const fingerprintEntries: Array<{ uri: string; fingerprint: string }> = [];

  const sourceContentFingerprint = await fingerprintUtf8Content(
    input.source.content
  );

  const orderedBuckets = [...byDocument.values()].sort((a, b) =>
    a.doc.relPath < b.doc.relPath ? -1 : a.doc.relPath > b.doc.relPath ? 1 : 0
  );

  for (const bucket of orderedBuckets) {
    const hasRewrite = bucket.edits.length > 0;
    const hasBlocking = bucket.examined.some(
      (row) =>
        row.classification === "ambiguous" ||
        row.classification === "unsupported" ||
        row.classification === "malformed" ||
        row.classification === "invalid"
    );
    if (!hasRewrite && !hasBlocking && bucket.examined.length === 0) continue;

    // Source uses the canonical fingerprint from input.source.content once.
    const contentFingerprint =
      bucket.doc.uri === input.source.uri
        ? sourceContentFingerprint
        : await fingerprintUtf8Content(bucket.doc.content ?? "");
    fingerprintEntries.push({
      uri: bucket.doc.uri,
      fingerprint: contentFingerprint,
    });
    affectedDocuments.push({
      uri: bucket.doc.uri,
      relPath: bucket.doc.relPath,
      contentFingerprint,
      edits: [...bucket.edits].sort((a, b) =>
        a.startOffset !== b.startOffset
          ? a.startOffset - b.startOffset
          : a.endOffset - b.endOffset
      ),
      examined: sortExaminedReferences(bucket.examined),
    });
  }

  const wikiLinkCount = orderedExamined.filter(
    (row) => row.kind === "wiki"
  ).length;
  const markdownLinkCount = orderedExamined.filter(
    (row) => row.kind === "markdown" || row.kind === "markdown_definition"
  ).length;
  const filenameChanged =
    pathBasename(input.source.relPath) !== pathBasename(input.target.relPath);
  const folderChanged =
    pathDirname(input.source.relPath) !== pathDirname(input.target.relPath);
  const warnings: string[] = [];
  if (orderedExamined.length > 0) {
    warnings.push(
      `${orderedExamined.length} backlink${orderedExamined.length === 1 ? "" : "s"} may need review after this refactor.`
    );
  }
  if (filenameChanged && wikiLinkCount > 0) {
    warnings.push(
      `${wikiLinkCount} wiki link${wikiLinkCount === 1 ? "" : "s"} may depend on the current title/path identity.`
    );
  }
  if ((filenameChanged || folderChanged) && markdownLinkCount > 0) {
    warnings.push(
      `${markdownLinkCount} markdown link${markdownLinkCount === 1 ? "" : "s"} may require path rewrite or manual review.`
    );
  }
  for (const code of uniqueTruncation) {
    warnings.push(`plan_truncated:${code}`);
  }

  const safety = summarizeReferenceClassifications(orderedExamined, {
    warnings,
    backlinks: orderedExamined.length,
    wikiLinks: wikiLinkCount,
    markdownLinks: markdownLinkCount,
  });

  if (uniqueTruncation.length > 0 && safety.invalidCount === 0) {
    safety.invalidCount = 1;
    if (!safety.blockingReasonCodes.includes("unsafe_target")) {
      safety.blockingReasonCodes = [
        ...safety.blockingReasonCodes,
        "unsafe_target" as const,
      ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    }
  }

  const targetPathFingerprint = await fingerprintUtf8Content(
    input.targetPathFingerprintSeed ??
      `${input.target.collection}:${input.target.relPath}:${input.targetOccupied ? "occupied" : "free"}`
  );

  const canApply = deriveCanApply({
    safety,
    sourceEditable: input.source.editable,
    targetOccupied: input.targetOccupied,
    sameCollection: true,
  });

  const withoutDigest: Omit<FileRefactorPreviewPlan, "planDigest"> = {
    schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
    operation: input.operation,
    conflictPolicy: "fail",
    source: {
      uri: input.source.uri,
      relPath: input.source.relPath,
      collection: input.source.collection,
    },
    target: {
      uri: input.target.uri,
      relPath: input.target.relPath,
      collection: input.target.collection,
    },
    affectedDocuments,
    examinedReferences: orderedExamined,
    preconditions: {
      sourceContentFingerprint,
      affectedContentFingerprints: fingerprintEntries.sort((a, b) =>
        a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0
      ),
      targetPathFingerprint,
    },
    safety,
    canApply,
    mutationBoundary: FILE_REFACTOR_MUTATION_BOUNDARY,
  };

  const planDigest = await computeFileRefactorPlanDigest(withoutDigest);
  return { ...withoutDigest, planDigest };
}
