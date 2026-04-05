/**
 * Shared file refactor planning helpers.
 *
 * Browser-safe path planning, with warning generation based on known link data.
 *
 * @module src/core/file-refactors
 */

// node:path has no Bun equivalent
import { posix as pathPosix } from "node:path";

import { validateRelPath } from "./validation";

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

export interface RenamePlan {
  nextRelPath: string;
  nextUri: string;
}

export interface MovePlan {
  nextRelPath: string;
  nextUri: string;
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

export function planRenameRefactor(input: {
  collection: string;
  currentRelPath: string;
  nextName: string;
}): RenamePlan {
  const current = validateRelPath(input.currentRelPath);
  const directory = pathPosix.dirname(current);
  const currentExt = pathPosix.extname(current);
  const nextFilename = pathPosix.extname(input.nextName)
    ? input.nextName
    : `${input.nextName}${currentExt}`;
  const nextRelPath =
    directory === "."
      ? validateRelPath(nextFilename)
      : validateRelPath(`${directory}/${nextFilename}`);

  return {
    nextRelPath,
    nextUri: `gno://${input.collection}/${nextRelPath}`,
  };
}

export function planMoveRefactor(input: {
  collection: string;
  currentRelPath: string;
  folderPath: string;
  nextName?: string;
}): MovePlan {
  const current = validateRelPath(input.currentRelPath);
  const safeFolder = validateRelPath(input.folderPath).replace(
    /^\.\/|\/+$/g,
    ""
  );
  const filename = input.nextName?.trim() || pathPosix.basename(current);
  const nextRelPath = safeFolder
    ? validateRelPath(`${safeFolder}/${filename}`)
    : validateRelPath(filename);

  return {
    nextRelPath,
    nextUri: `gno://${input.collection}/${nextRelPath}`,
  };
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
