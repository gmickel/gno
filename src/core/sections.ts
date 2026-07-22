/**
 * Shared section extraction and anchor helpers.
 *
 * Browser-safe.
 *
 * @module src/core/sections
 */

export interface DocumentSection {
  anchor: string;
  level: number;
  line: number;
  title: string;
}

const HEADING_REGEX = /^(#{1,6})\s+(.+?)\s*#*\s*$/u;
const FENCE_REGEX = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const FENCE_CLOSE_REGEX = /^ {0,3}(`{3,}|~{3,})[\t ]*$/u;

interface OpenFence {
  marker: "`" | "~";
  length: number;
}

const fenceOpener = (line: string): OpenFence | null => {
  const match = FENCE_REGEX.exec(line);
  const run = match?.[1];
  const suffix = match?.[2] ?? "";
  if (!run || (run[0] === "`" && suffix.includes("`"))) return null;
  return { marker: run[0] as OpenFence["marker"], length: run.length };
};

const closesFence = (line: string, fence: OpenFence): boolean => {
  const run = FENCE_CLOSE_REGEX.exec(line)?.[1];
  return Boolean(run && run[0] === fence.marker && run.length >= fence.length);
};

export function slugifySectionTitle(title: string): string {
  return (
    title
      .normalize("NFC")
      .toLowerCase()
      .trim()
      .replaceAll(/[^\p{L}\p{N}\s-]/gu, "")
      .replaceAll(/\s+/g, "-")
      .replaceAll(/-+/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

export function extractSections(content: string): DocumentSection[] {
  const sections: DocumentSection[] = [];
  const counts = new Map<string, number>();
  const lines = content.split("\n");
  let openFence: OpenFence | null = null;

  for (const [index, line] of lines.entries()) {
    if (openFence) {
      if (closesFence(line, openFence)) openFence = null;
      continue;
    }
    const opener = fenceOpener(line);
    if (opener) {
      openFence = opener;
      continue;
    }
    const match = HEADING_REGEX.exec(line);
    if (!match) {
      continue;
    }

    const level = match[1]?.length ?? 0;
    const title = match[2]?.trim() ?? "";
    if (!title) {
      continue;
    }

    const baseAnchor = slugifySectionTitle(title);
    const count = (counts.get(baseAnchor) ?? 0) + 1;
    counts.set(baseAnchor, count);
    const anchor = count === 1 ? baseAnchor : `${baseAnchor}-${count}`;

    sections.push({
      anchor,
      level,
      line: index + 1,
      title,
    });
  }

  return sections;
}

/** Extract one inclusive, 1-based line range without normalizing source bytes. */
export function extractInclusiveLines(
  content: string,
  startLine: number,
  endLine: number
): string | null {
  if (
    content.includes("\r") ||
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    return null;
  }
  const lines = content.split("\n");
  if (endLine > lines.length) return null;
  return lines.slice(startLine - 1, endLine).join("\n");
}

/** Find the nearest Markdown heading governing a 1-based source line. */
export function headingForLine(
  sections: readonly DocumentSection[],
  line: number
): string | null {
  let heading: string | null = null;
  for (const section of sections) {
    if (section.line > line) break;
    heading = section.title;
  }
  return heading;
}
