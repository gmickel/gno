/**
 * Shared note creation path resolution and collision handling.
 *
 * Browser-safe: no Bun APIs.
 *
 * @module src/core/note-creation
 */

// node:path has no Bun equivalent
import { posix as pathPosix } from "node:path";

import { validateRelPath } from "./validation";

export type NoteCollisionPolicy =
  | "error"
  | "open_existing"
  | "create_with_suffix";

export interface ResolveNoteCreateInput {
  collection: string;
  title?: string;
  relPath?: string;
  folderPath?: string;
  collisionPolicy?: NoteCollisionPolicy;
}

export interface NoteCreatePlan {
  collection: string;
  folderPath: string;
  relPath: string;
  filename: string;
  collisionPolicy: NoteCollisionPolicy;
  openedExisting: boolean;
  createdWithSuffix: boolean;
}

export function sanitizeNoteFilename(title: string): string {
  return title
    .normalize("NFC")
    .toLowerCase()
    .trim()
    .replaceAll(/[^\w\s-]/g, "")
    .replaceAll(/\s+/g, "-")
    .replaceAll(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function ensureMarkdownFilename(filename: string): string {
  return pathPosix.extname(filename) ? filename : `${filename}.md`;
}

function nextAvailableRelPath(relPath: string, existing: Set<string>): string {
  const parsed = pathPosix.parse(relPath);
  const ext = parsed.ext || ".md";
  const dir = parsed.dir ? `${parsed.dir}/` : "";
  const base = parsed.name || "untitled";

  let counter = 2;
  while (true) {
    const candidate = `${dir}${base}-${counter}${ext}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
    counter += 1;
  }
}

export function resolveNoteCreatePlan(
  input: ResolveNoteCreateInput,
  existingRelPaths: Iterable<string>
): NoteCreatePlan {
  const collisionPolicy = input.collisionPolicy ?? "error";
  const existing = new Set(existingRelPaths);
  const safeFolderPath = input.folderPath
    ? validateRelPath(input.folderPath).replace(/^\.\/|\/+$/g, "")
    : "";

  let baseRelPath: string;
  if (input.relPath?.trim()) {
    baseRelPath = validateRelPath(input.relPath.trim());
  } else {
    const baseTitle = input.title?.trim() || "untitled";
    const filename = ensureMarkdownFilename(
      sanitizeNoteFilename(baseTitle) || "untitled"
    );
    baseRelPath = safeFolderPath ? `${safeFolderPath}/${filename}` : filename;
  }

  const relPath = safeFolderPath
    ? baseRelPath.startsWith(`${safeFolderPath}/`) ||
      baseRelPath === safeFolderPath
      ? baseRelPath
      : `${safeFolderPath}/${pathPosix.basename(baseRelPath)}`
    : baseRelPath;
  const normalizedRelPath = validateRelPath(relPath);

  if (!existing.has(normalizedRelPath)) {
    return {
      collection: input.collection,
      folderPath: safeFolderPath,
      relPath: normalizedRelPath,
      filename: pathPosix.basename(normalizedRelPath),
      collisionPolicy,
      openedExisting: false,
      createdWithSuffix: false,
    };
  }

  if (collisionPolicy === "open_existing") {
    return {
      collection: input.collection,
      folderPath: safeFolderPath,
      relPath: normalizedRelPath,
      filename: pathPosix.basename(normalizedRelPath),
      collisionPolicy,
      openedExisting: true,
      createdWithSuffix: false,
    };
  }

  if (collisionPolicy === "create_with_suffix") {
    const nextRelPath = nextAvailableRelPath(normalizedRelPath, existing);
    return {
      collection: input.collection,
      folderPath: safeFolderPath,
      relPath: nextRelPath,
      filename: pathPosix.basename(nextRelPath),
      collisionPolicy,
      openedExisting: false,
      createdWithSuffix: true,
    };
  }

  throw new Error(
    "File already exists. Use open_existing or create_with_suffix."
  );
}
