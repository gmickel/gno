/**
 * Live filesystem validation before reference-safe refactor mutation.
 *
 * @module src/core/file-refactor-apply-validate
 */

// node:fs/promises realpath/lstat — no Bun equivalent for symlink-safe identity
import { lstat, realpath } from "node:fs/promises";
// node:path — no Bun path utils
import { dirname, isAbsolute, normalize } from "node:path";

import type { PreparedRefactorFile } from "./file-refactor-apply-fs";
import type {
  FileRefactorApplyResult,
  FileRefactorPreviewPlan,
  FileRefactorReasonCode,
} from "./file-refactor-contract";

import { parseUri } from "../app/constants";
import {
  applyDestinationEditsDescending,
  FileRefactorEditError,
} from "./file-refactor-apply-edits";
import { resolveCollectionAbsPath } from "./file-refactor-apply-fs";
import {
  FILE_REFACTOR_SCHEMA_VERSION,
  fingerprintUtf8Content,
} from "./file-refactor-contract";
import {
  pathDirname,
  validateFileRefactorPlanInputs,
} from "./file-refactor-plan-validate";
import { isCanonicalPathContained, validateRelPath } from "./validation";

function baseResult(
  plan: FileRefactorPreviewPlan
): Pick<
  FileRefactorApplyResult,
  "schemaVersion" | "planDigest" | "operation" | "source" | "target"
> {
  return {
    schemaVersion: FILE_REFACTOR_SCHEMA_VERSION,
    planDigest: plan.planDigest,
    operation: plan.operation,
    source: plan.source,
    target: plan.target,
  };
}

export function unchangedResult(
  plan: FileRefactorPreviewPlan,
  status: "conflict" | "stale_plan" | "unsupported",
  reasonCode: FileRefactorReasonCode,
  recoveryJournalId?: string
): FileRefactorApplyResult {
  return {
    ...baseResult(plan),
    status,
    reasonCode,
    filesystem: { state: "unchanged", recoveryJournalId },
    indexConvergence: { state: "not_attempted" },
  };
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function nearestExistingParentRealpath(
  absPath: string
): Promise<string | null> {
  let candidate = dirname(absPath);
  while (true) {
    const resolved = await realpathOrNull(candidate);
    if (resolved) return resolved;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

async function assertExistingPathContained(
  rootReal: string,
  absPath: string
): Promise<boolean> {
  const real = await realpathOrNull(absPath);
  if (!real) return false;
  return isCanonicalPathContained(rootReal, real);
}

async function assertTargetPathContained(
  rootReal: string,
  targetAbs: string
): Promise<boolean> {
  // Reject final path if it already exists as a symlink escape.
  try {
    const info = await lstat(targetAbs);
    if (info.isSymbolicLink()) return false;
    const real = await realpath(targetAbs);
    return isCanonicalPathContained(rootReal, real);
  } catch {
    // Target must not exist for apply; validate nearest existing parent.
  }
  const parentReal = await nearestExistingParentRealpath(targetAbs);
  if (!parentReal) return false;
  return isCanonicalPathContained(rootReal, parentReal);
}

/**
 * Structural plan integrity independent of live filesystem bytes.
 * Malformed but self-digested canApply=true plans fail closed here.
 */
export function validateRefactorPlanStructure(
  plan: FileRefactorPreviewPlan
): FileRefactorApplyResult | null {
  const inputFailure = validateFileRefactorPlanInputs({
    operation: plan.operation,
    source: plan.source,
    target: plan.target,
  });
  if (inputFailure) {
    return unchangedResult(plan, "unsupported", inputFailure.reasonCode);
  }

  if (plan.source.collection !== plan.target.collection) {
    return unchangedResult(plan, "unsupported", "cross_collection_unsupported");
  }

  if (plan.source.uri === plan.target.uri) {
    return unchangedResult(plan, "unsupported", "unsafe_target");
  }
  if (plan.source.relPath === plan.target.relPath) {
    return unchangedResult(plan, "unsupported", "unsafe_target");
  }

  if (plan.operation === "rename") {
    if (pathDirname(plan.source.relPath) !== pathDirname(plan.target.relPath)) {
      return unchangedResult(plan, "unsupported", "unsafe_target");
    }
  }

  const sourceParsed = parseUri(plan.source.uri);
  const targetParsed = parseUri(plan.target.uri);
  if (
    !sourceParsed ||
    !targetParsed ||
    sourceParsed.collection !== plan.source.collection ||
    sourceParsed.path !== plan.source.relPath ||
    targetParsed.collection !== plan.target.collection ||
    targetParsed.path !== plan.target.relPath
  ) {
    return unchangedResult(plan, "unsupported", "unsafe_target");
  }

  const seenUris = new Set<string>();
  const seenRelPaths = new Set<string>();
  for (const doc of plan.affectedDocuments) {
    if (seenUris.has(doc.uri) || seenRelPaths.has(doc.relPath)) {
      return unchangedResult(plan, "unsupported", "unsafe_target");
    }
    seenUris.add(doc.uri);
    seenRelPaths.add(doc.relPath);

    const parsed = parseUri(doc.uri);
    if (
      !parsed ||
      parsed.path !== doc.relPath ||
      parsed.collection !== plan.source.collection
    ) {
      return unchangedResult(plan, "unsupported", "unsafe_target");
    }
    if (doc.uri !== plan.source.uri && doc.relPath === plan.source.relPath) {
      return unchangedResult(plan, "unsupported", "unsafe_target");
    }
    if (doc.uri === plan.source.uri && doc.relPath !== plan.source.relPath) {
      return unchangedResult(plan, "unsupported", "unsafe_target");
    }
    if (doc.relPath === plan.target.relPath || doc.uri === plan.target.uri) {
      return unchangedResult(plan, "unsupported", "unsafe_target");
    }
  }

  const fingerprintUris = plan.preconditions.affectedContentFingerprints.map(
    (entry) => entry.uri
  );
  const fingerprintSet = new Set(fingerprintUris);
  if (fingerprintSet.size !== fingerprintUris.length) {
    return unchangedResult(plan, "unsupported", "unsafe_target");
  }
  if (fingerprintSet.size !== plan.affectedDocuments.length) {
    return unchangedResult(plan, "unsupported", "unsafe_target");
  }
  for (const doc of plan.affectedDocuments) {
    if (!fingerprintSet.has(doc.uri)) {
      return unchangedResult(plan, "unsupported", "unsafe_target");
    }
  }

  return null;
}

type PreparedCore = Omit<
  PreparedRefactorFile,
  "stagePath" | "backupPath" | "stageRelPath" | "backupRelPath"
>;

export async function validateLiveRefactorPlan(
  plan: FileRefactorPreviewPlan,
  collectionRoot: string
): Promise<
  | { ok: true; files: PreparedCore[] }
  | { ok: false; result: FileRefactorApplyResult }
> {
  const structural = validateRefactorPlanStructure(plan);
  if (structural) return { ok: false, result: structural };

  let sourceRel: string;
  let targetRel: string;
  try {
    sourceRel = validateRelPath(plan.source.relPath);
    targetRel = validateRelPath(plan.target.relPath);
  } catch {
    return {
      ok: false,
      result: unchangedResult(plan, "unsupported", "unsafe_target"),
    };
  }

  const rootReal = await realpathOrNull(normalize(collectionRoot));
  if (!rootReal || !isAbsolute(rootReal)) {
    return {
      ok: false,
      result: unchangedResult(plan, "unsupported", "unsafe_target"),
    };
  }

  const sourceAbs = resolveCollectionAbsPath(collectionRoot, sourceRel);
  const targetAbs = resolveCollectionAbsPath(collectionRoot, targetRel);

  if (!(await assertExistingPathContained(rootReal, sourceAbs))) {
    return {
      ok: false,
      result: unchangedResult(plan, "unsupported", "unsafe_target"),
    };
  }
  if (!(await assertTargetPathContained(rootReal, targetAbs))) {
    return {
      ok: false,
      result: unchangedResult(plan, "unsupported", "unsafe_target"),
    };
  }

  const sourceContent = await Bun.file(sourceAbs)
    .text()
    .catch(() => null);
  if (sourceContent === null) {
    return {
      ok: false,
      result: unchangedResult(plan, "stale_plan", "stale_plan"),
    };
  }
  const sourceFp = await fingerprintUtf8Content(sourceContent);
  if (sourceFp !== plan.preconditions.sourceContentFingerprint) {
    return {
      ok: false,
      result: unchangedResult(plan, "stale_plan", "stale_plan"),
    };
  }

  const targetExists = await Bun.file(targetAbs).exists();
  const expectedTargetFp = await fingerprintUtf8Content(
    `${plan.target.collection}:${plan.target.relPath}:${targetExists ? "occupied" : "free"}`
  );
  if (expectedTargetFp !== plan.preconditions.targetPathFingerprint) {
    return {
      ok: false,
      result: unchangedResult(
        plan,
        targetExists ? "conflict" : "stale_plan",
        targetExists ? "occupied_target" : "stale_plan"
      ),
    };
  }
  if (targetExists) {
    return {
      ok: false,
      result: unchangedResult(plan, "conflict", "occupied_target"),
    };
  }

  const contentByUri = new Map<string, string>();
  contentByUri.set(plan.source.uri, sourceContent);
  const files: PreparedCore[] = [];
  const preconditionByUri = new Map(
    plan.preconditions.affectedContentFingerprints.map((entry) => [
      entry.uri,
      entry.fingerprint,
    ])
  );

  for (const doc of plan.affectedDocuments) {
    let rel: string;
    try {
      rel = validateRelPath(doc.relPath);
    } catch {
      return {
        ok: false,
        result: unchangedResult(plan, "unsupported", "unsafe_target"),
      };
    }

    const abs = resolveCollectionAbsPath(collectionRoot, rel);
    if (!(await assertExistingPathContained(rootReal, abs))) {
      return {
        ok: false,
        result: unchangedResult(plan, "unsupported", "unsafe_target"),
      };
    }

    const isSource = doc.uri === plan.source.uri || rel === sourceRel;
    let content = contentByUri.get(doc.uri);
    if (content === undefined) {
      const live = await Bun.file(abs)
        .text()
        .catch(() => null);
      if (live === null) {
        return {
          ok: false,
          result: unchangedResult(plan, "stale_plan", "stale_plan"),
        };
      }
      content = live;
      contentByUri.set(doc.uri, content);
    }

    const liveFp = await fingerprintUtf8Content(content);
    if (liveFp !== doc.contentFingerprint) {
      return {
        ok: false,
        result: unchangedResult(plan, "stale_plan", "stale_plan"),
      };
    }
    const precondition = preconditionByUri.get(doc.uri);
    if (precondition !== liveFp) {
      return {
        ok: false,
        result: unchangedResult(plan, "stale_plan", "stale_plan"),
      };
    }

    let finalContent: string;
    try {
      finalContent = applyDestinationEditsDescending(content, doc.edits);
    } catch (cause) {
      if (cause instanceof FileRefactorEditError) {
        return {
          ok: false,
          result: unchangedResult(plan, "stale_plan", "stale_plan"),
        };
      }
      throw cause;
    }

    if (isSource) {
      contentByUri.set(plan.source.uri, finalContent);
      continue;
    }

    files.push({
      role: "affected",
      sourceAbsPath: abs,
      targetAbsPath: abs,
      relPath: rel,
      finalContent,
      originalFingerprint: liveFp,
      expectedFingerprint: await fingerprintUtf8Content(finalContent),
      isMove: false,
    });
  }

  const finalSourceContent = contentByUri.get(plan.source.uri) ?? sourceContent;
  files.push({
    role: "source",
    sourceAbsPath: sourceAbs,
    targetAbsPath: targetAbs,
    relPath: targetRel,
    sourceRelPath: sourceRel,
    finalContent: finalSourceContent,
    originalFingerprint: sourceFp,
    expectedFingerprint: await fingerprintUtf8Content(finalSourceContent),
    isMove: true,
  });

  return { ok: true, files };
}

export { baseResult };
