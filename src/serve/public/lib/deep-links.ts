export interface DocumentDeepLinkTarget {
  uri: string;
  view?: "rendered" | "source";
  lineStart?: number;
  lineEnd?: number;
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) return;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return;
  }
  return parsed;
}

export function buildDocDeepLink(target: DocumentDeepLinkTarget): string {
  const params = new URLSearchParams({ uri: target.uri });

  if (target.view) {
    params.set("view", target.view);
  }
  if (target.lineStart) {
    params.set("lineStart", String(target.lineStart));
  }
  if (
    target.lineStart !== undefined &&
    target.lineEnd !== undefined &&
    target.lineEnd >= target.lineStart
  ) {
    params.set("lineEnd", String(target.lineEnd));
  }

  return `/doc?${params.toString()}`;
}

export function buildEditDeepLink(target: DocumentDeepLinkTarget): string {
  const params = new URLSearchParams({ uri: target.uri });

  if (target.lineStart) {
    params.set("lineStart", String(target.lineStart));
  }
  if (
    target.lineStart !== undefined &&
    target.lineEnd !== undefined &&
    target.lineEnd >= target.lineStart
  ) {
    params.set("lineEnd", String(target.lineEnd));
  }

  return `/edit?${params.toString()}`;
}

export function parseDocumentDeepLink(search: string): DocumentDeepLinkTarget {
  const params = new URLSearchParams(search);
  const uri = params.get("uri") ?? "";
  const viewParam = params.get("view");
  const view = viewParam === "source" ? "source" : "rendered";
  const lineStart = parsePositiveInteger(params.get("lineStart"));
  const lineEnd = parsePositiveInteger(params.get("lineEnd"));

  return {
    uri,
    view,
    lineStart,
    lineEnd,
  };
}
