/**
 * Shared Markdown section extraction (ATX headings + fence awareness).
 * Private helper module — import public API from `./sections`.
 *
 * @module src/core/section-parse
 */

export interface DocumentSection {
  anchor: string;
  level: number;
  line: number;
  title: string;
}

/** Structural section record used by target create/resolve. */
export interface SectionRecord {
  section: DocumentSection;
  headingPath: string[];
  occurrence: number;
  /** Inclusive start line through exclusive end line of section body. */
  endLine: number;
  titleStartOffset: number;
  titleEndOffset: number;
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

export const normalizeHeadingTitle = (title: string): string =>
  title.normalize("NFC").trim();

export const pathKey = (headingPath: readonly string[]): string =>
  headingPath.join("\0");

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

export const lineStartOffsets = (content: string): number[] => {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") offsets.push(index + 1);
  }
  return offsets;
};

/** Extract structural section records (no quote evidence). */
export function extractSectionRecords(content: string): SectionRecord[] {
  const records: SectionRecord[] = [];
  const counts = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  const lines = content.split("\n");
  const starts = lineStartOffsets(content);
  let openFence: OpenFence | null = null;
  const stack: { level: number; title: string }[] = [];

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
    if (!match) continue;

    const level = match[1]?.length ?? 0;
    const title = match[2]?.trim() ?? "";
    if (!title) continue;

    const normalizedTitle = normalizeHeadingTitle(title);
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) {
      stack.pop();
    }
    stack.push({ level, title: normalizedTitle });
    const headingPath = stack.map((entry) => entry.title);
    const occurrence = (pathCounts.get(pathKey(headingPath)) ?? 0) + 1;
    pathCounts.set(pathKey(headingPath), occurrence);

    const baseAnchor = slugifySectionTitle(title);
    const count = (counts.get(baseAnchor) ?? 0) + 1;
    counts.set(baseAnchor, count);
    const anchor = count === 1 ? baseAnchor : `${baseAnchor}-${count}`;

    const lineStart = starts[index] ?? 0;
    const titleOffsetInLine = line.indexOf(title);
    const titleStartOffset =
      titleOffsetInLine >= 0 ? lineStart + titleOffsetInLine : lineStart;
    const titleEndOffset = titleStartOffset + title.length;

    records.push({
      section: {
        anchor,
        level,
        line: index + 1,
        title,
      },
      headingPath,
      occurrence,
      endLine: lines.length,
      titleStartOffset,
      titleEndOffset,
    });
  }

  for (const [recordIndex, record] of records.entries()) {
    let endLine = lines.length;
    for (let next = recordIndex + 1; next < records.length; next += 1) {
      const candidate = records[next];
      if (candidate && candidate.section.level <= record.section.level) {
        endLine = candidate.section.line - 1;
        break;
      }
    }
    record.endLine = endLine;
  }

  return records;
}

export function extractSections(content: string): DocumentSection[] {
  return extractSectionRecords(content).map((record) => record.section);
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
