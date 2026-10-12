/**
 * Collection root availability: the one notion of "this root can be listed"
 * shared by sync (before proving a file deleted) and status/doctor (to name
 * a missing or unreadable root at read time).
 *
 * @module src/ingestion/source-availability/root
 */

// node:fs constants: access mode bits (no Bun equivalent)
import { constants } from "node:fs";
// node:fs/promises access/opendir/stat: Bun has no directory-handle API
import { access, opendir, stat } from "node:fs/promises";

import type { Collection } from "../../config/types";

/** A configured collection whose root cannot be used right now. */
export interface CollectionRootError {
  code: "SOURCE_AVAILABILITY_UNKNOWN";
  /** Why, without the host path (status payloads redact paths remotely). */
  message: string;
}

/** The error that stops listing `root`, or null when it can be listed. */
async function rootListError(root: string): Promise<Error | null> {
  try {
    const directory = await opendir(root);
    try {
      // The open is lazy; the first read is what needs list permission.
      await directory.read();
    } finally {
      await directory.close();
    }
    return null;
  } catch (cause) {
    return cause instanceof Error
      ? cause
      : new Error("the folder could not be listed", { cause });
  }
}

/** Null when the collection root can be listed; otherwise why it cannot. */
export async function unavailableRootMessage(
  root: string
): Promise<string | null> {
  const cause = await rootListError(root);
  if (cause === null) {
    return null;
  }
  return `Collection root could not be resolved (${cause.message}); indexed documents were kept`;
}

/** "ENOENT: no such file or directory" from a filesystem error, path dropped. */
function describeRootError(cause: unknown): string {
  if (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    // Node/Bun format: "<CODE>: <description>, <syscall> '<path>'".
    return cause.message.startsWith(`${cause.code}:`)
      ? (cause.message.split(", ")[0] ?? cause.code)
      : cause.code;
  }
  return "the folder could not be checked";
}

/**
 * Check one configured root at read time. `local` collections never list the
 * root (listing a dataless cloud folder would download it, and a partially
 * present cloud folder is not missing); they check that it is a directory
 * this process may read and enter.
 */
export async function checkCollectionRoot(
  collection: Pick<Collection, "path" | "sourceAvailability">
): Promise<CollectionRootError | null> {
  let detail: string | null;
  if (collection.sourceAvailability === "local") {
    try {
      if ((await stat(collection.path)).isDirectory()) {
        await access(collection.path, constants.R_OK | constants.X_OK);
        detail = null;
      } else {
        detail = "ENOTDIR: not a directory";
      }
    } catch (cause) {
      detail = describeRootError(cause);
    }
  } else {
    const cause = await rootListError(collection.path);
    detail = cause === null ? null : describeRootError(cause);
  }
  if (detail === null) {
    return null;
  }
  return {
    code: "SOURCE_AVAILABILITY_UNKNOWN",
    message: `Collection root is missing or unreadable (${detail}); indexed documents were kept`,
  };
}

/** Root errors of the given collections by name; available roots are absent. */
export async function checkCollectionRoots(
  collections: ReadonlyArray<
    Pick<Collection, "name" | "path" | "sourceAvailability">
  >
): Promise<Record<string, CollectionRootError>> {
  const checked = await Promise.all(
    collections.map(
      async (collection) =>
        [collection.name, await checkCollectionRoot(collection)] as const
    )
  );
  const errors: Record<string, CollectionRootError> = {};
  for (const [name, error] of checked) {
    if (error) errors[name] = error;
  }
  return errors;
}

/** Marks each collection whose root is unavailable and clears `healthy`. */
export async function withCollectionRootErrors<
  T extends { healthy: boolean; collections: Array<{ name: string }> },
>(
  status: T,
  collections: ReadonlyArray<
    Pick<Collection, "name" | "path" | "sourceAvailability">
  >
): Promise<T> {
  const errors = await checkCollectionRoots(collections);
  if (Object.keys(errors).length === 0) return status;
  return {
    ...status,
    healthy: false,
    collections: status.collections.map((c) =>
      errors[c.name] ? { ...c, rootError: errors[c.name] } : c
    ),
  };
}
