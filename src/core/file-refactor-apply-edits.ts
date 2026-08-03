/**
 * Destination-only multi-span edits for reference-safe apply.
 *
 * @module src/core/file-refactor-apply-edits
 */

import type { FileRefactorDestinationSpan } from "./file-refactor-contract";

import { applyDestinationOnlyEdit } from "./file-refactor-contract";

export class FileRefactorEditError extends Error {
  readonly code: "stale_span" | "overlapping_spans";

  constructor(code: "stale_span" | "overlapping_spans", message: string) {
    super(message);
    this.name = "FileRefactorEditError";
    this.code = code;
  }
}

/**
 * Apply destination-only edits in descending UTF-16 offsets.
 * Verifies non-overlap against original coordinates and exact original slices.
 */
export function applyDestinationEditsDescending(
  content: string,
  edits: FileRefactorDestinationSpan[]
): string {
  if (edits.length === 0) return content;

  const ascending = [...edits].sort(
    (left, right) => left.startOffset - right.startOffset
  );
  for (let index = 1; index < ascending.length; index += 1) {
    const prev = ascending[index - 1];
    const next = ascending[index];
    if (!prev || !next) continue;
    if (next.startOffset < prev.endOffset) {
      throw new FileRefactorEditError(
        "overlapping_spans",
        "Destination edit spans overlap"
      );
    }
  }

  const descending = [...edits].sort(
    (left, right) => right.startOffset - left.startOffset
  );
  let result = content;
  for (const edit of descending) {
    try {
      result = applyDestinationOnlyEdit(result, edit);
    } catch (cause) {
      throw new FileRefactorEditError(
        "stale_span",
        cause instanceof Error ? cause.message : "Stale destination span"
      );
    }
  }
  return result;
}
