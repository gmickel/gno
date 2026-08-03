/**
 * Input validation for reference-safe file refactor planning.
 *
 * Fail closed with stable diagnostics — never throw after a partial plan.
 *
 * @module src/core/file-refactor-plan-validate
 */

// node:path/posix — no Bun path utils
import { posix as pathPosix } from "node:path";

import type {
  FileRefactorExaminedReference,
  FileRefactorOperation,
  FileRefactorReasonCode,
} from "./file-refactor-contract";

import { parseUri } from "../app/constants";

export interface FileRefactorPlanValidationFailure {
  canApply: false;
  reasonCode: FileRefactorReasonCode;
  diagnostic: string;
  examined: FileRefactorExaminedReference[];
}

function pathBasename(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx >= 0 ? relPath.slice(idx + 1) : relPath;
}

function pathDirname(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx >= 0 ? relPath.slice(0, idx) : "";
}

function isUnsafeRelPath(relPath: string): string | null {
  if (!relPath || !relPath.trim()) return "empty_path";
  if (relPath.includes("\0")) return "null_byte";
  if (relPath.includes("\\")) return "backslash_path";
  if (pathPosix.isAbsolute(relPath) || relPath.startsWith("/")) {
    return "absolute_path";
  }
  if (relPath.endsWith("/")) return "non_file_path";
  const segments = relPath.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return "non_canonical_path";
  }
  if (segments.some((segment) => segment === ".")) {
    return "dot_component";
  }
  if (segments.some((segment) => segment === "..")) {
    return "path_traversal";
  }
  const normalized = pathPosix.normalize(relPath);
  if (normalized !== relPath) return "non_canonical_path";
  if (normalized.startsWith("..") || normalized.split("/").includes("..")) {
    return "path_traversal";
  }
  const base = pathBasename(relPath);
  if (!base || base === "." || base === "..") return "non_file_path";
  return null;
}

function uriMatches(uri: string, collection: string, relPath: string): boolean {
  const parsed = parseUri(uri);
  if (!parsed) return false;
  return parsed.collection === collection && parsed.path === relPath;
}

/**
 * Validate source/target coherence before computing replacements.
 * Returns a failure descriptor, or null when inputs are safe to plan.
 */
export function validateFileRefactorPlanInputs(input: {
  operation: FileRefactorOperation;
  source: {
    uri: string;
    relPath: string;
    collection: string;
  };
  target: {
    uri: string;
    relPath: string;
    collection: string;
  };
}): FileRefactorPlanValidationFailure | null {
  const sourceUnsafe = isUnsafeRelPath(input.source.relPath);
  if (sourceUnsafe) {
    return failure(
      input,
      "unsafe_target",
      `invalid_source_path:${sourceUnsafe}`
    );
  }
  const targetUnsafe = isUnsafeRelPath(input.target.relPath);
  if (targetUnsafe) {
    return failure(
      input,
      "unsafe_target",
      `invalid_target_path:${targetUnsafe}`
    );
  }

  if (input.source.collection !== input.target.collection) {
    return failure(
      input,
      "cross_collection_unsupported",
      "cross_collection_target"
    );
  }

  if (
    input.source.relPath === input.target.relPath ||
    input.source.uri === input.target.uri
  ) {
    return failure(input, "unsafe_target", "source_matches_target");
  }

  if (
    !uriMatches(input.source.uri, input.source.collection, input.source.relPath)
  ) {
    return failure(input, "unsafe_target", "source_uri_path_mismatch");
  }
  if (
    !uriMatches(input.target.uri, input.target.collection, input.target.relPath)
  ) {
    return failure(input, "unsafe_target", "target_uri_path_mismatch");
  }

  if (input.operation === "rename") {
    if (
      pathDirname(input.source.relPath) !== pathDirname(input.target.relPath)
    ) {
      return failure(input, "unsafe_target", "rename_directory_changed");
    }
  }

  return null;
}

function failure(
  input: {
    source: { uri: string; relPath: string };
  },
  reasonCode: FileRefactorReasonCode,
  diagnostic: string
): FileRefactorPlanValidationFailure {
  return {
    canApply: false,
    reasonCode,
    diagnostic,
    examined: [
      {
        documentUri: input.source.uri,
        documentRelPath: input.source.relPath,
        kind: "opaque",
        classification:
          reasonCode === "cross_collection_unsupported"
            ? "unsupported"
            : "invalid",
        reasonCode,
        originalDestination: diagnostic,
      },
    ],
  };
}

export { pathBasename, pathDirname };
