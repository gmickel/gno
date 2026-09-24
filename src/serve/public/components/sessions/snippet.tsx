import type { ReactNode } from "react";

const MARK_OPEN = "<mark>";
const MARK_CLOSE = "</mark>";

/** CommonMark backslash escape: `\` before any ASCII punctuation character. */
const MARKDOWN_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;

/** Drop Markdown backslash escapes (`state.db\#` -> `state.db#`). */
export function unescapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_ESCAPE, "$1");
}

/**
 * Render a search snippet: FTS `<mark>` highlights become real <mark>
 * elements, everything else stays React text (never parsed as HTML).
 * Mirrors the Search page renderer, plus Markdown-escape removal because
 * archived turns are indexed as escaped Markdown.
 */
export function renderSessionSnippet(snippet: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let remaining = snippet;
  let key = 0;

  while (remaining.length > 0) {
    const markStart = remaining.indexOf(MARK_OPEN);
    if (markStart === -1) {
      parts.push(unescapeMarkdown(remaining));
      break;
    }
    if (markStart > 0) {
      parts.push(unescapeMarkdown(remaining.slice(0, markStart)));
    }
    const markEnd = remaining.indexOf(MARK_CLOSE, markStart);
    if (markEnd === -1) {
      parts.push(unescapeMarkdown(remaining.slice(markStart)));
      break;
    }
    parts.push(
      <mark
        className="rounded bg-primary/20 px-0.5 font-medium text-primary"
        key={key++}
      >
        {unescapeMarkdown(
          remaining.slice(markStart + MARK_OPEN.length, markEnd)
        )}
      </mark>
    );
    remaining = remaining.slice(markEnd + MARK_CLOSE.length);
  }

  return parts;
}
