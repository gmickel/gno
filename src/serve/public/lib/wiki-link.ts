export interface WikiLinkQuery {
  query: string;
  start: number;
  end: number;
}

export function getActiveWikiLinkQuery(
  content: string,
  cursorPos: number
): WikiLinkQuery | null {
  if (cursorPos < 2) {
    return null;
  }

  const prefix = content.slice(0, cursorPos);
  const start = prefix.lastIndexOf("[[");
  if (start === -1) {
    return null;
  }

  const closing = prefix.indexOf("]]", start);
  if (closing !== -1) {
    return null;
  }

  const query = prefix.slice(start + 2);
  if (query.includes("\n")) {
    return null;
  }

  return {
    query,
    start,
    end: cursorPos,
  };
}
