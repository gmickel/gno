// node:path has no Bun equivalent
import { posix as pathPosix } from "node:path";

export type DocumentCapabilityMode = "editable" | "read_only";

export interface DocumentCapabilities {
  editable: boolean;
  tagsEditable: boolean;
  tagsWriteback: boolean;
  canCreateEditableCopy: boolean;
  mode: DocumentCapabilityMode;
  reason?: string;
}

export const MARKDOWN_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".markdown",
  ".mdx",
]);

const EDITABLE_EXTENSIONS = new Set([
  ...MARKDOWN_SOURCE_EXTENSIONS,
  ".txt",
  ".text",
]);

function isTextLikeMime(mime: string): boolean {
  return mime.startsWith("text/");
}

/**
 * True when a document may carry markdown/wiki/HTML references in mirror text.
 * Used by refactor inventory completeness to fail closed on missing mirrors.
 * Non-text binaries (pdf/images/…) are omitted — they cannot hold those refs.
 */
export function isTextLikeReferenceDocument(
  sourceExt: string,
  sourceMime: string
): boolean {
  const ext = sourceExt.toLowerCase();
  return EDITABLE_EXTENSIONS.has(ext) || isTextLikeMime(sourceMime);
}

export function getDocumentCapabilities(input: {
  sourceExt: string;
  sourceMime: string;
  contentAvailable: boolean;
  recordKey?: string | null;
}): DocumentCapabilities {
  const ext = input.sourceExt.toLowerCase();
  if (input.recordKey) {
    return {
      editable: false,
      tagsEditable: true,
      tagsWriteback: false,
      canCreateEditableCopy: input.contentAvailable,
      mode: "read_only",
      reason:
        "This document is a logical record derived from a file/export container and cannot be written back in place.",
    };
  }
  const editable =
    EDITABLE_EXTENSIONS.has(ext) || isTextLikeMime(input.sourceMime);
  const tagsWriteback = MARKDOWN_SOURCE_EXTENSIONS.has(ext);

  if (editable) {
    return {
      editable: true,
      tagsEditable: true,
      tagsWriteback,
      canCreateEditableCopy: false,
      mode: "editable",
    };
  }

  return {
    editable: false,
    tagsEditable: true,
    tagsWriteback: false,
    canCreateEditableCopy: input.contentAvailable,
    mode: "read_only",
    reason:
      "This document is derived from a source format that GNO cannot safely write back in place.",
  };
}

export function deriveEditableCopyRelPath(
  relPath: string,
  existingRelPaths: Iterable<string> = []
): string {
  const parsed = pathPosix.parse(relPath);
  const prefix = parsed.dir ? `${parsed.dir}/` : "";
  const baseName = parsed.name || "copy";
  const existing = new Set(existingRelPaths);

  const baseCandidate = MARKDOWN_SOURCE_EXTENSIONS.has(parsed.ext.toLowerCase())
    ? `${prefix}${baseName}.copy.md`
    : `${prefix}${baseName}.md`;

  if (!existing.has(baseCandidate)) {
    return baseCandidate;
  }

  let counter = 2;
  while (true) {
    const candidate = `${prefix}${baseName}.copy-${counter}.md`;
    if (!existing.has(candidate)) {
      return candidate;
    }
    counter += 1;
  }
}

export function buildEditableCopyContent(input: {
  title: string;
  sourceDocid: string;
  sourceUri: string;
  sourceMime: string;
  sourceExt: string;
  content: string;
  tags?: string[];
}): string {
  const frontmatterLines = [
    `title: ${JSON.stringify(input.title)}`,
    `gno_source_docid: ${JSON.stringify(input.sourceDocid)}`,
    `gno_source_uri: ${JSON.stringify(input.sourceUri)}`,
    `gno_source_mime: ${JSON.stringify(input.sourceMime)}`,
    `gno_source_ext: ${JSON.stringify(input.sourceExt)}`,
  ];

  if (input.tags && input.tags.length > 0) {
    frontmatterLines.push("tags:");
    for (const tag of input.tags) {
      frontmatterLines.push(`  - ${JSON.stringify(tag)}`);
    }
  }

  return `---\n${frontmatterLines.join("\n")}\n---\n\n${input.content}`;
}
