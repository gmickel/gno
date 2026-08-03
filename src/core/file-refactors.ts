/**
 * Shared file refactor planning helpers and reference-safe contract exports.
 *
 * Browser-safe path planning and warning generation based on known link data.
 * Versioned preview/apply contracts live in `file-refactor-contract.ts` and are
 * re-exported here for a stable import path.
 *
 * @module src/core/file-refactors
 */

// node:path has no Bun equivalent
import { posix as pathPosix } from "node:path";

import { validateRelPath } from "./validation";

export {
  applyDestinationOnlyEdit,
  compareExaminedReferences,
  compareUtf16CodeUnits,
  computeFileRefactorPlanDigest,
  deriveCanApply,
  FILE_REFACTOR_APPLY_CONFIRMATION,
  FILE_REFACTOR_MUTATION_BOUNDARY,
  FILE_REFACTOR_REASON_CODES,
  FILE_REFACTOR_SCHEMA_VERSION,
  fingerprintUtf8Content,
  isBytePreservedOutsideSpan,
  isContentPreservedOutsideSpan,
  sortExaminedReferences,
  stableStringify,
  summarizeReferenceClassifications,
  type FileRefactorAffectedDocument,
  type FileRefactorApplyRequest,
  type FileRefactorApplyResult,
  type FileRefactorApplyStatus,
  type FileRefactorConflictPolicy,
  type FileRefactorDestinationSpan,
  type FileRefactorDocumentRef,
  type FileRefactorExaminedReference,
  type FileRefactorFilesystemState,
  type FileRefactorIndexConvergenceState,
  type FileRefactorMutationBoundary,
  type FileRefactorOperation,
  type FileRefactorPreconditions,
  type FileRefactorPreviewPlan,
  type FileRefactorReasonCode,
  type FileRefactorReferenceClassification,
  type FileRefactorReferenceKind,
  type FileRefactorSafetySummary,
} from "./file-refactor-contract";

export {
  FILE_REFACTOR_PLANNER_CAPS,
  planFileRefactorImpact,
  type FileRefactorPlannerDocument,
  type PlanFileRefactorImpactInput,
} from "./file-refactor-planner";

export {
  planFileRefactorImpactFromSnapshot,
  planInputFromResolutionSnapshot,
  type FileRefactorSnapshotLike,
} from "./file-refactor-from-snapshot";

export {
  applyFileRefactor,
  createMemoryFileRefactorJournal,
  journalPortFromStore,
  type ApplyFileRefactorDeps,
  type FileRefactorBoundaryHook,
  type FileRefactorSyncCallback,
} from "./file-refactor-service";

export {
  applyCanonicalFileRefactor,
  assertFileRefactorSyncConverged,
  buildCanonicalRefactorPlan,
  buildDurableFileRefactorApplyDeps,
  collectionRefactorLockPath,
  FILE_REFACTOR_COLLECTION_LOCK_NAME,
  parseRefactorApplyConfirmation,
  resolveMoveTarget,
  resolveRenameTarget,
  type BuildCanonicalRefactorPlanInput,
  type FileRefactorPathTarget,
  type ParsedRefactorApplyConfirmation,
} from "./file-refactor-adapter";

export {
  planMoveRefactor,
  planRenameRefactor,
  type MovePlan,
  type RenamePlan,
} from "./file-refactor-paths";

export interface RefactorWarningSummary {
  warnings: string[];
  backlinkCount: number;
  wikiLinkCount: number;
  markdownLinkCount: number;
}

export interface RefactorLinkSnapshot {
  backlinks: number;
  wikiLinks: number;
  markdownLinks: number;
}

export interface DuplicatePlan {
  nextRelPath: string;
  nextUri: string;
}

export function buildRefactorWarnings(
  snapshot: RefactorLinkSnapshot,
  options: {
    filenameChanged?: boolean;
    folderChanged?: boolean;
  } = {}
): RefactorWarningSummary {
  const warnings: string[] = [];

  if (snapshot.backlinks > 0) {
    warnings.push(
      `${snapshot.backlinks} backlink${snapshot.backlinks === 1 ? "" : "s"} may need review after this refactor.`
    );
  }
  if (options.filenameChanged && snapshot.wikiLinks > 0) {
    warnings.push(
      `${snapshot.wikiLinks} wiki link${snapshot.wikiLinks === 1 ? "" : "s"} may depend on the current title/path identity.`
    );
  }
  if (
    (options.filenameChanged || options.folderChanged) &&
    snapshot.markdownLinks > 0
  ) {
    warnings.push(
      `${snapshot.markdownLinks} markdown link${snapshot.markdownLinks === 1 ? "" : "s"} may require path rewrite or manual review.`
    );
  }

  return {
    warnings,
    backlinkCount: snapshot.backlinks,
    wikiLinkCount: snapshot.wikiLinks,
    markdownLinkCount: snapshot.markdownLinks,
  };
}

function nextAvailableRelPath(relPath: string, existing: Set<string>): string {
  const parsed = pathPosix.parse(relPath);
  const dir = parsed.dir ? `${parsed.dir}/` : "";
  const base = parsed.name || "copy";
  const ext = parsed.ext || ".md";

  let counter = 2;
  while (true) {
    const candidate = `${dir}${base}-${counter}${ext}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
    counter += 1;
  }
}

export function planDuplicateRefactor(input: {
  collection: string;
  currentRelPath: string;
  folderPath?: string;
  nextName?: string;
  existingRelPaths: Iterable<string>;
}): DuplicatePlan {
  const current = validateRelPath(input.currentRelPath);
  const existing = new Set(input.existingRelPaths);
  const targetFolder = input.folderPath
    ? validateRelPath(input.folderPath).replace(/^\.\/|\/+$/g, "")
    : pathPosix.dirname(current) === "."
      ? ""
      : pathPosix.dirname(current);
  const baseName = input.nextName?.trim() || pathPosix.basename(current);
  const initialRelPath = targetFolder
    ? validateRelPath(`${targetFolder}/${baseName}`)
    : validateRelPath(baseName);
  const nextRelPath = existing.has(initialRelPath)
    ? nextAvailableRelPath(initialRelPath, existing)
    : initialRelPath;

  return {
    nextRelPath,
    nextUri: `gno://${input.collection}/${nextRelPath}`,
  };
}

export function planCreateFolder(input: {
  parentPath?: string;
  name: string;
}): string {
  const safeName = input.name.trim().replaceAll(/[\\/]+/g, "");
  if (!safeName) {
    throw new Error("Folder name cannot be empty");
  }
  const safeParent = input.parentPath
    ? validateRelPath(input.parentPath).replace(/^\.\/|\/+$/g, "")
    : "";
  return safeParent
    ? validateRelPath(`${safeParent}/${safeName}`)
    : validateRelPath(safeName);
}
