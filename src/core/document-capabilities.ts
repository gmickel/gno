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

const EDITABLE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".text",
]);

function isTextLikeMime(mime: string): boolean {
  return mime.startsWith("text/");
}

export function getDocumentCapabilities(input: {
  sourceExt: string;
  sourceMime: string;
  contentAvailable: boolean;
}): DocumentCapabilities {
  const ext = input.sourceExt.toLowerCase();
  const editable =
    EDITABLE_EXTENSIONS.has(ext) || isTextLikeMime(input.sourceMime);
  const tagsWriteback = ext === ".md" || ext === ".markdown" || ext === ".mdx";

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

  const baseCandidate =
    parsed.ext.toLowerCase() === ".md" ||
    parsed.ext.toLowerCase() === ".markdown" ||
    parsed.ext.toLowerCase() === ".mdx"
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
