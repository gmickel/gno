/**
 * Display-layer snippet cleaning for search/query results.
 * Strips leading YAML frontmatter so snippets prefer prose. Does not change
 * indexed text, `--full` content, or `--line-numbers` raw chunks.
 *
 * @module src/pipeline/snippet
 */

import { stripFrontmatter } from "../ingestion/frontmatter";

/** FTS5 highlight markers from snippet(documents_fts, ..., '<mark>', '</mark>', '...', 32). */
const MARK_TAG_REGEX = /<\/?mark>/g;

/** Leading blank lines after a closed frontmatter fence. */
const LEADING_BLANK_LINES_REGEX = /^(?:[ \t]*\r?\n)+/;

/** YAML mapping line (`key: value` or `key:`). */
const YAML_MAPPING_LINE_REGEX = /^[\w./-]+\s*:/;

/** YAML sequence item. */
const YAML_SEQUENCE_LINE_REGEX = /^- /;

export interface DisplaySnippet {
  text: string;
  /**
   * Lines to add to the chunk's startLine when the emitted text is derived
   * from stripped chunk prose (not a kept FTS window).
   */
  startLineOffset: number;
  /** True when a frontmatter-dominated FTS snippet was replaced by chunk prose. */
  usedChunkFallback: boolean;
}

/**
 * Clean a default-path snippet: strip a leading closed YAML fence, or replace
 * an FTS window that is only frontmatter with stripped chunk prose.
 * Never returns an empty string when the original text had content.
 */
export function cleanDisplaySnippet(
  snippet: string,
  chunkText?: string
): DisplaySnippet {
  const strippedSnippet = stripLeadingFrontmatterBlock(snippet);
  if (strippedSnippet.didStrip) {
    return {
      text: strippedSnippet.text,
      startLineOffset: strippedSnippet.lineCount,
      usedChunkFallback: false,
    };
  }

  const afterEmbeddedFence = proseAfterEmbeddedFrontmatterFence(snippet);
  if (afterEmbeddedFence !== undefined) {
    const cleanedChunk =
      chunkText === undefined
        ? undefined
        : stripLeadingFrontmatterBlock(chunkText);
    return {
      text: afterEmbeddedFence,
      startLineOffset: cleanedChunk?.didStrip ? cleanedChunk.lineCount : 0,
      usedChunkFallback: false,
    };
  }

  const canFallback =
    chunkText !== undefined &&
    chunkText !== snippet &&
    isFrontmatterDominatedSnippetInner(snippet, true);
  if (canFallback) {
    const cleanedChunk = stripLeadingFrontmatterBlock(chunkText);
    if (cleanedChunk.text.length > 0) {
      return {
        text: cleanedChunk.text,
        startLineOffset: cleanedChunk.didStrip ? cleanedChunk.lineCount : 0,
        usedChunkFallback: true,
      };
    }
  }

  return {
    text: snippet,
    startLineOffset: 0,
    usedChunkFallback: false,
  };
}

/** True for FTS-style snippets that are only (or start as) YAML frontmatter. */
export function isFrontmatterDominatedSnippet(text: string): boolean {
  return isFrontmatterDominatedSnippetInner(text, false);
}

function isFrontmatterDominatedSnippetInner(
  text: string,
  skipEmbeddedFenceCheck: boolean
): boolean {
  const unmarked = text.replace(MARK_TAG_REGEX, "");
  const trimmed = unmarked.trimStart();
  const withoutLeadingEllipsis = trimmed.startsWith("...")
    ? trimmed.slice(3).trimStart()
    : trimmed;
  if (withoutLeadingEllipsis.startsWith("---")) {
    return true;
  }

  const contentLines = unmarked.split(/\r?\n/).filter((line) => {
    const trimmedLine = line.trim();
    return trimmedLine.length > 0 && trimmedLine !== "...";
  });
  if (contentLines.length === 0) {
    return false;
  }
  if (contentLines.every(isYamlFrontmatterLine)) {
    return true;
  }
  return (
    !skipEmbeddedFenceCheck &&
    proseAfterEmbeddedFrontmatterFence(text) !== undefined
  );
}

/**
 * FTS windows often straddle the closing fence (`...yaml\n---\n# Heading`).
 * Keep the prose after that fence when the prefix looks like YAML.
 */
function proseAfterEmbeddedFrontmatterFence(text: string): string | undefined {
  if (!text.includes("-")) {
    return undefined;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    if (line.replace(MARK_TAG_REGEX, "").trim() !== "---") {
      continue;
    }
    const prefixLines = lines.slice(0, i);
    if (!prefixLooksLikeFrontmatter(prefixLines)) {
      continue;
    }
    const after = lines
      .slice(i + 1)
      .join("\n")
      .replace(LEADING_BLANK_LINES_REGEX, "");
    if (after.trim().length === 0) {
      continue;
    }
    return after;
  }
  return undefined;
}

function prefixLooksLikeFrontmatter(lines: string[]): boolean {
  const content = lines.filter((line) => {
    const trimmed = line.replace(MARK_TAG_REGEX, "").trim();
    return trimmed.length > 0 && trimmed !== "...";
  });
  if (content.length === 0) {
    return true;
  }
  return content.every((line, index) => {
    const trimmed = line.replace(MARK_TAG_REGEX, "").trim();
    if (index === 0 && trimmed.startsWith("...")) {
      return true;
    }
    return isYamlFrontmatterLine(trimmed);
  });
}

function stripLeadingFrontmatterBlock(text: string): {
  text: string;
  didStrip: boolean;
  lineCount: number;
} {
  const afterFence = stripFrontmatter(text);
  if (afterFence === text) {
    return { text, didStrip: false, lineCount: 0 };
  }

  const withoutBlanks = afterFence.replace(LEADING_BLANK_LINES_REGEX, "");
  if (withoutBlanks.trim().length === 0) {
    return { text, didStrip: false, lineCount: 0 };
  }

  const prefix = text.slice(0, text.length - withoutBlanks.length);
  return {
    text: withoutBlanks,
    didStrip: true,
    lineCount: countConsumedLines(prefix),
  };
}

function isYamlFrontmatterLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "---") {
    return true;
  }
  if (YAML_SEQUENCE_LINE_REGEX.test(trimmed)) {
    return true;
  }
  return YAML_MAPPING_LINE_REGEX.test(trimmed);
}

function countConsumedLines(prefix: string): number {
  if (prefix.length === 0) {
    return 0;
  }
  let newlineCount = 0;
  for (const char of prefix) {
    if (char === "\n") {
      newlineCount += 1;
    }
  }
  return prefix.endsWith("\n") ? newlineCount : newlineCount + 1;
}
