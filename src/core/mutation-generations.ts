/** Shared mutation detection for resident content and vector generations. */

interface SyncMutationCounts {
  filesAdded?: number;
  filesUpdated?: number;
  filesMarkedInactive?: number;
  totalFilesAdded?: number;
  totalFilesUpdated?: number;
  collections?: readonly SyncMutationCounts[];
}

export function hasContentMutation(result: SyncMutationCounts): boolean {
  return (
    (result.filesAdded ?? result.totalFilesAdded ?? 0) > 0 ||
    (result.filesUpdated ?? result.totalFilesUpdated ?? 0) > 0 ||
    (result.filesMarkedInactive ?? 0) > 0 ||
    result.collections?.some(hasContentMutation) === true
  );
}

export function recordContentMutation(
  result: SyncMutationCounts,
  markMutation: (() => void) | undefined
): void {
  if (hasContentMutation(result)) markMutation?.();
}

export function recordIndexMutation(
  embedded: number,
  markMutation: (() => void) | undefined
): void {
  if (embedded > 0) markMutation?.();
}
