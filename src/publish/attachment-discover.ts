/** CommonMark + Obsidian image discovery for publish attachments. */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import {
  type ExcludedRange,
  getExcludedRanges,
  rangeIntersectsExcluded,
} from "../ingestion/strip";
import { parseObsidianEmbedAt } from "./attachment-obsidian";

export interface DiscoveredImageRef {
  alt: string;
  end: number;
  kind: "markdown" | "obsidian";
  sourceRef: string;
  start: number;
  title?: string | null;
}

export interface DiscoverImageOptions {
  excludeFrontmatter?: boolean;
}

interface PositionedNode {
  alt?: string | null;
  children?: PositionedNode[];
  identifier?: string;
  position?: {
    end: { offset?: number };
    start: { offset?: number };
  };
  type: string;
  title?: string | null;
  url?: string;
}

interface MarkdownScan {
  definitions: Map<string, { title: string | null; url: string }>;
  excluded: ExcludedRange[];
  images: DiscoveredImageRef[];
  references: PositionedNode[];
}

const nodeOffsets = (
  node: PositionedNode
): { end: number; start: number } | null => {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : { start, end };
};

const markdownImage = (
  node: PositionedNode,
  sourceRef: string,
  title: string | null
): DiscoveredImageRef | null => {
  const offsets = nodeOffsets(node);
  if (!offsets) return null;
  return {
    alt: node.alt ?? "",
    end: offsets.end,
    kind: "markdown",
    sourceRef,
    start: offsets.start,
    title,
  };
};

const scanMarkdownAst = (markdown: string): MarkdownScan => {
  const root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as PositionedNode;
  const scan: MarkdownScan = {
    definitions: new Map(),
    excluded: [],
    images: [],
    references: [],
  };

  const visit = (node: PositionedNode): void => {
    const offsets = nodeOffsets(node);
    if (
      offsets &&
      (node.type === "code" ||
        node.type === "inlineCode" ||
        node.type === "html" ||
        node.type === "definition")
    ) {
      scan.excluded.push({ ...offsets, kind: "inline_code" });
    }
    if (offsets && node.type === "link") {
      const isAutolink =
        markdown[offsets.start] === "<" && markdown[offsets.end - 1] === ">";
      const childEnds = (node.children ?? [])
        .map((child) => nodeOffsets(child)?.end)
        .filter((offset): offset is number => offset !== undefined);
      scan.excluded.push({
        start: isAutolink
          ? offsets.start
          : childEnds.length === 0
            ? offsets.start
            : Math.max(...childEnds),
        end: offsets.end,
        kind: "inline_code",
      });
    }
    if (
      node.type === "definition" &&
      node.identifier !== undefined &&
      node.url !== undefined &&
      !scan.definitions.has(node.identifier)
    ) {
      scan.definitions.set(node.identifier, {
        title: node.title ?? null,
        url: node.url,
      });
    } else if (node.type === "image" && node.url !== undefined) {
      const image = markdownImage(node, node.url, node.title ?? null);
      if (image) scan.images.push(image);
    } else if (node.type === "imageReference") {
      scan.references.push(node);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);

  for (const reference of scan.references) {
    const definition = scan.definitions.get(reference.identifier ?? "");
    if (definition === undefined) continue;
    const image = markdownImage(reference, definition.url, definition.title);
    if (image) scan.images.push(image);
  }
  return scan;
};

const isEscapedMarker = (text: string, index: number): boolean => {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
};

const discoverObsidianImages = (
  markdown: string,
  excluded: ExcludedRange[]
): DiscoveredImageRef[] => {
  const images: DiscoveredImageRef[] = [];
  let cursor = 0;
  while (cursor < markdown.length) {
    const bang = markdown.indexOf("![[", cursor);
    if (bang < 0) break;
    const parsed = isEscapedMarker(markdown, bang)
      ? null
      : parseObsidianEmbedAt(markdown, bang);
    if (
      parsed &&
      !rangeIntersectsExcluded(parsed.start, parsed.end, excluded)
    ) {
      images.push(parsed);
    }
    cursor = parsed?.end ?? bang + 1;
  }
  return images;
};

export const discoverImageOccurrences = (
  markdown: string,
  options: DiscoverImageOptions = {}
): DiscoveredImageRef[] => {
  const scan = scanMarkdownAst(markdown);
  const frontmatter =
    options.excludeFrontmatter === false
      ? []
      : getExcludedRanges(markdown).filter(
          (range) => range.kind === "frontmatter"
        );
  const markdownImageRanges: ExcludedRange[] = scan.images.map((image) => ({
    start: image.start,
    end: image.end,
    kind: "inline_code",
  }));
  const excluded = [
    ...scan.excluded,
    ...frontmatter,
    ...markdownImageRanges,
  ].sort((left, right) => left.start - right.start);
  const markdownImages = scan.images.filter(
    (image) => !rangeIntersectsExcluded(image.start, image.end, frontmatter)
  );
  return [
    ...markdownImages,
    ...discoverObsidianImages(markdown, excluded),
  ].sort((left, right) => left.start - right.start || left.end - right.end);
};
