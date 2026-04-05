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

  for (const [index, line] of lines.entries()) {
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
