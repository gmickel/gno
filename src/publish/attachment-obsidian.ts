/** Obsidian image-embed parsing for publish attachment discovery. */

import type { DiscoveredImageRef } from "./attachment-discover";

const parseObsidianTarget = (
  raw: string
): { alias: string; pathPart: string } => {
  // Markdown tables require Obsidian's separator pipes to be escaped. Restore
  // those escapes before applying Obsidian's target|alias grammar.
  const normalized = raw.replaceAll("\\|", "|");
  const pipe = normalized.indexOf("|");
  const pathWithFrag = pipe >= 0 ? normalized.slice(0, pipe) : normalized;
  const alias = pipe >= 0 ? normalized.slice(pipe + 1).trim() : "";
  const hash = pathWithFrag.indexOf("#");
  const pathPart = (
    hash >= 0 ? pathWithFrag.slice(0, hash) : pathWithFrag
  ).trim();
  return { alias, pathPart };
};

export const parseObsidianEmbedAt = (
  text: string,
  bangIndex: number
): DiscoveredImageRef | null => {
  if (text.slice(bangIndex, bangIndex + 3) !== "![[") return null;
  let i = bangIndex + 3;
  let raw = "";
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "]" && text[i + 1] === "]") {
      const parsed = parseObsidianTarget(raw);
      return {
        alt: parsed.alias,
        end: i + 2,
        kind: "obsidian",
        sourceRef: parsed.pathPart,
        start: bangIndex,
      };
    }
    if (ch === "\n" || ch === "\r") return null;
    raw += ch;
    i += 1;
  }
  return null;
};
