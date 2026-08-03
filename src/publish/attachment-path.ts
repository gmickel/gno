/**
 * Collection-root path confinement and basename lookup for publish attachments.
 *
 * @module src/publish/attachment-path
 */

// node:fs/promises realpath/lstat/opendir — no Bun equivalents for symlink-safe identity or prunable directory walking
import { lstat, opendir, realpath } from "node:fs/promises";
// node:path — no Bun path utils
import {
  isAbsolute,
  join,
  normalize,
  posix as pathPosix,
  relative,
  sep,
} from "node:path";

import type { AttachmentDiagnostic } from "./attachment-types";

import { matchesCollectionExclusion } from "../core/path-rules";
import { isCanonicalPathContained } from "../core/validation";

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const isPrivateAttachmentRelPath = (relPath: string): boolean =>
  relPath.split("/").some((segment) => segment.toLowerCase() === "_internal");

export const diagnostic = (
  code: AttachmentDiagnostic["code"],
  message: string,
  noteSlug: string,
  sourceRef: string
): AttachmentDiagnostic => ({ code, message, noteSlug, sourceRef });

export const safePercentDecode = (value: string): string | null => {
  let current = value;
  for (let round = 0; round < 4; round += 1) {
    if (!/%[0-9a-fA-F]{2}/u.test(current)) return current;
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) return current;
      if (decoded.includes("\0")) return null;
      current = decoded;
    } catch {
      return null;
    }
  }
  return current;
};

const percentDecodeOnce = (value: string): string | null => {
  if (!/%[0-9a-fA-F]{2}/u.test(value)) return value;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.includes("\0") ? null : decoded;
  } catch {
    return null;
  }
};

export const extensionOf = (relPath: string): string => {
  const base = pathPosix.basename(relPath);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
};

/**
 * Build basename → relPath[] index for files under root.
 *
 * Unsupported files must remain discoverable so the resolver can report a
 * stable unsupported-format diagnostic instead of misclassifying them as
 * missing. Byte validation still decides whether any match may be bundled.
 */
export async function buildAttachmentBasenameIndex(
  collectionRoot: string,
  collectionExcludes: readonly string[] = []
): Promise<Map<string, string[]>> {
  let rootReal: string;
  try {
    rootReal = await realpath(normalize(collectionRoot));
  } catch {
    return new Map();
  }
  const index = new Map<string, string[]>();
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    let directory: Awaited<ReturnType<typeof opendir>>;
    try {
      directory = await opendir(absDir);
    } catch {
      return;
    }
    for await (const entry of directory) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const excluded =
        matchesCollectionExclusion(rel, collectionExcludes) ||
        (entry.isDirectory() &&
          matchesCollectionExclusion(`${rel}/`, collectionExcludes));
      if (isPrivateAttachmentRelPath(rel) || excluded) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(join(absDir, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const base = pathPosix.basename(rel);
      const bucket = index.get(base) ?? [];
      bucket.push(rel);
      index.set(base, bucket);
    }
  };
  await walk(rootReal, "");
  for (const [key, values] of index) {
    index.set(key, [...new Set(values)].sort(compareCodeUnits));
  }
  return index;
}

export interface AttachmentPathContext {
  basenameIndex: Map<string, string[]>;
  collectionExcludes?: readonly string[];
  noteSlug: string;
  sourceRelPath: string;
}

const stripMarkdownUrlSuffix = (sourceRef: string): string => {
  const fragmentIndex = sourceRef.indexOf("#");
  const queryIndex = sourceRef.indexOf("?");
  const suffixIndexes = [fragmentIndex, queryIndex].filter(
    (index) => index >= 0
  );
  if (suffixIndexes.length === 0) return sourceRef;
  return sourceRef.slice(0, Math.min(...suffixIndexes));
};

export const resolveCandidateRelPath = (
  sourceRef: string,
  ctx: AttachmentPathContext,
  kind: "markdown" | "obsidian"
):
  | { ok: true; relPath: string }
  | { ok: false; diagnostic: AttachmentDiagnostic } => {
  // Markdown destinations follow URL semantics: raw query/fragment suffixes
  // are not part of the local filename. Split before percent-decoding so an
  // encoded literal `%23` or `%3F` can still address a real filename.
  const pathSourceRef =
    kind === "markdown" ? stripMarkdownUrlSuffix(sourceRef) : sourceRef;
  const decoded = percentDecodeOnce(pathSourceRef);
  const securityDecoded = safePercentDecode(pathSourceRef);
  if (decoded === null || securityDecoded === null || decoded.trim() === "") {
    return {
      ok: false,
      diagnostic: diagnostic(
        "ASSET_CORRUPT",
        "Malformed image reference encoding",
        ctx.noteSlug,
        sourceRef
      ),
    };
  }
  if (
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    securityDecoded.includes("\\")
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "ASSET_TRAVERSAL",
        "Image reference escapes the approved collection root",
        ctx.noteSlug,
        sourceRef
      ),
    };
  }
  if (
    isAbsolute(decoded) ||
    pathPosix.isAbsolute(decoded) ||
    isAbsolute(securityDecoded) ||
    pathPosix.isAbsolute(securityDecoded)
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "ASSET_TRAVERSAL",
        "Absolute image paths are not allowed",
        ctx.noteSlug,
        sourceRef
      ),
    };
  }

  const hasSlash = decoded.includes("/");
  if (!hasSlash && kind === "obsidian") {
    const matches = ctx.basenameIndex.get(pathPosix.basename(decoded)) ?? [];
    if (matches.length === 0) {
      return {
        ok: false,
        diagnostic: diagnostic(
          "ASSET_MISSING",
          `No file named "${pathPosix.basename(decoded)}" under collection root`,
          ctx.noteSlug,
          sourceRef
        ),
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        diagnostic: diagnostic(
          "ASSET_AMBIGUOUS",
          `Ambiguous basename "${pathPosix.basename(decoded)}" matches ${matches.length} files`,
          ctx.noteSlug,
          sourceRef
        ),
      };
    }
    return { ok: true, relPath: matches[0]! };
  }

  const baseDir =
    kind === "obsidian" && hasSlash ? "" : pathPosix.dirname(ctx.sourceRelPath);
  const joined = pathPosix.normalize(
    pathPosix.join(baseDir === "." ? "" : baseDir, decoded)
  );
  const securityJoined = pathPosix.normalize(
    pathPosix.join(baseDir === "." ? "" : baseDir, securityDecoded)
  );
  if (
    joined.startsWith("..") ||
    joined.split("/").includes("..") ||
    pathPosix.isAbsolute(joined) ||
    securityJoined.startsWith("..") ||
    securityJoined.split("/").includes("..") ||
    pathPosix.isAbsolute(securityJoined)
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "ASSET_TRAVERSAL",
        "Image reference escapes the approved collection root",
        ctx.noteSlug,
        sourceRef
      ),
    };
  }
  if (
    isPrivateAttachmentRelPath(joined) ||
    matchesCollectionExclusion(joined, ctx.collectionExcludes ?? [])
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "ASSET_MISSING",
        "Attachment not found",
        ctx.noteSlug,
        sourceRef
      ),
    };
  }
  return { ok: true, relPath: joined.replace(/^\.\//u, "") };
};

export async function assertContainedFile(
  collectionRoot: string,
  relPath: string,
  noteSlug: string,
  sourceRef: string,
  collectionExcludes: readonly string[] = []
): Promise<{ absPath: string } | AttachmentDiagnostic> {
  const rootReal = await realpath(normalize(collectionRoot));
  const absLexical = normalize(join(rootReal, ...relPath.split("/")));
  if (!isCanonicalPathContained(rootReal, absLexical)) {
    throw new Error(
      `ASSET_TRAVERSAL: image path escapes collection root (${sourceRef})`
    );
  }
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(absLexical);
  } catch {
    return diagnostic(
      "ASSET_MISSING",
      `Attachment not found: ${relPath}`,
      noteSlug,
      sourceRef
    );
  }
  if (info.isSymbolicLink()) {
    throw new Error(
      `ASSET_TRAVERSAL: refusing symlink attachment (${sourceRef})`
    );
  }
  if (!info.isFile()) {
    return diagnostic(
      "ASSET_MISSING",
      `Attachment is not a regular file: ${relPath}`,
      noteSlug,
      sourceRef
    );
  }
  let absReal: string;
  try {
    absReal = await realpath(absLexical);
  } catch {
    throw new Error(
      `ASSET_TRAVERSAL: unable to realpath attachment (${sourceRef})`
    );
  }
  if (!isCanonicalPathContained(rootReal, absReal)) {
    throw new Error(
      `ASSET_TRAVERSAL: symlink escape outside collection root (${sourceRef})`
    );
  }
  const canonicalRelPath = relative(rootReal, absReal).split(sep).join("/");
  if (
    isPrivateAttachmentRelPath(canonicalRelPath) ||
    matchesCollectionExclusion(canonicalRelPath, collectionExcludes)
  ) {
    return diagnostic(
      "ASSET_MISSING",
      "Attachment not found",
      noteSlug,
      sourceRef
    );
  }
  return { absPath: absReal };
}
